/**
 * ГдеКод — Scheduler
 * Tiered scheduling: Tier 1 (3ч), Tier 2 (8ч), Tier 3 (24ч)
 * Запускается из Azure Functions Timer Trigger.
 *
 * Принимает аргумент --tier=1|2|3|urgent
 * Azure Functions настроены на разные CRON расписания для каждого tier.
 */

const { checkCoupon }        = require('./checker');
const { reportBatch }        = require('./reporter');
const { processUrgentQueue } = require('./queue');

const YANDEX_API_BASE  = process.env.YANDEX_API_URL || 'https://api.gde-code.ru';
const PARSER_SECRET    = process.env.PARSER_SECRET_KEY;
const BATCH_SIZE       = parseInt(process.env.BATCH_SIZE || '10');  // промокодов за раз
const MAX_CONCURRENCY  = parseInt(process.env.MAX_CONCURRENCY || '3'); // параллельных браузеров

// Jitter ±10 минут — не палим паттерн ботов
const JITTER_MS = 10 * 60 * 1000;

/**
 * Случайный jitter в диапазоне [-JITTER_MS, +JITTER_MS]
 */
async function applyJitter() {
  const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
  if (jitter > 0) {
    console.log(`[scheduler] Jitter: ждём ${Math.round(jitter / 1000)} сек`);
    await new Promise(r => setTimeout(r, jitter));
  }
}

/**
 * Получаем список промокодов для проверки по tier
 * @param {number} tier — 1, 2 или 3
 * @param {number} offset — для пагинации
 * @param {number} limit
 */
async function fetchCouponsForTier(tier, offset = 0, limit = BATCH_SIZE) {
  try {
    const url = `${YANDEX_API_BASE}/api/admin/parser/coupons?tier=${tier}&offset=${offset}&limit=${limit}&status=active`;
    const response = await fetch(url, {
      headers: { 'X-Parser-Secret': PARSER_SECRET },
    });

    if (!response.ok) {
      console.error(`[scheduler] Ошибка получения купонов tier=${tier}: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.coupons || [];

  } catch (err) {
    console.error(`[scheduler] Сетевая ошибка: ${err.message}`);
    return [];
  }
}

/**
 * Обрабатываем один батч промокодов с ограничением параллелизма
 * @param {Array} coupons
 */
async function processBatch(coupons) {
  const results = [];

  // Разбиваем на чанки по MAX_CONCURRENCY
  for (let i = 0; i < coupons.length; i += MAX_CONCURRENCY) {
    const chunk = coupons.slice(i, i + MAX_CONCURRENCY);

    console.log(`[scheduler] Проверяем ${chunk.length} промокодов (${i + 1}-${i + chunk.length} из ${coupons.length})`);

    const chunkResults = await Promise.allSettled(
      chunk.map(coupon => checkCoupon(coupon))
    );

    chunkResults.forEach((settled, idx) => {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      } else {
        // Если Promise упал — помечаем как needs_manual_check
        results.push({
          coupon_id:  chunk[idx].id,
          status:     'needs_manual_check',
          checked_at: new Date().toISOString(),
          error:      settled.reason?.message || 'Неизвестная ошибка',
        });
      }
    });

    // Пауза между чанками — не перегружаем сайты и Azure
    if (i + MAX_CONCURRENCY < coupons.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return results;
}

/**
 * Запуск проверки для одного tier
 * @param {number} tier — 1, 2 или 3
 */
async function runTier(tier) {
  console.log(`[scheduler] === Запуск Tier ${tier} ===`);

  // Применяем jitter — только для tier 2 и 3, tier 1 и так редкий
  if (tier > 1) {
    await applyJitter();
  }

  let offset = 0;
  let totalChecked = 0;
  let totalActive = 0;
  let totalExpired = 0;
  let totalManual = 0;

  while (true) {
    const coupons = await fetchCouponsForTier(tier, offset, BATCH_SIZE);

    if (coupons.length === 0) {
      console.log(`[scheduler] Tier ${tier}: больше нет промокодов для проверки`);
      break;
    }

    console.log(`[scheduler] Tier ${tier}: получено ${coupons.length} промокодов (offset=${offset})`);

    const results = await processBatch(coupons);

    // Считаем статистику
    results.forEach(r => {
      if (r.status === 'active') totalActive++;
      else if (r.status === 'expired') totalExpired++;
      else totalManual++;
    });

    // Отправляем результаты в Yandex
    await reportBatch(results);

    totalChecked += results.length;
    offset += BATCH_SIZE;

    // Пауза между батчами
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log(`[scheduler] Tier ${tier} завершён:`);
  console.log(`  Проверено: ${totalChecked}`);
  console.log(`  Active:    ${totalActive}`);
  console.log(`  Expired:   ${totalExpired}`);
  console.log(`  Manual:    ${totalManual}`);

  // После каждого tier-батча — обрабатываем срочную очередь
  await processUrgentQueue();
}

/**
 * Точка входа — запускается из Azure Functions Timer
 * Принимает tier через env или аргумент
 */
async function main() {
  const tier = parseInt(process.env.PARSER_TIER || process.argv[2]?.replace('--tier=', '') || '1');
  const isUrgent = process.argv.includes('--urgent') || process.env.PARSER_TIER === 'urgent';

  if (isUrgent) {
    console.log('[scheduler] === Запуск режима URGENT ===');
    await processUrgentQueue();
    return;
  }

  if (![1, 2, 3].includes(tier)) {
    console.error(`[scheduler] Неверный tier: ${tier}. Ожидается 1, 2 или 3.`);
    process.exit(1);
  }

  await runTier(tier);
}

main().catch(err => {
  console.error('[scheduler] Критическая ошибка:', err);
  process.exit(1);
});

module.exports = { runTier };
