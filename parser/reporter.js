/**
 * ГдеКод — Reporter
 * Отправляет результаты парсера в Yandex API.
 *
 * ★ ВАЖНО по 152-ФЗ:
 * Этот модуль передаёт ТОЛЬКО обезличенные данные о промокодах.
 * Никаких user_id, телефонов, email в этих запросах нет.
 */

const YANDEX_API_BASE = process.env.YANDEX_API_URL || 'https://api.gde-code.ru';
const PARSER_SECRET   = process.env.PARSER_SECRET_KEY; // секретный ключ Azure → Yandex

/**
 * Отправляем результат проверки промокода в Yandex API
 *
 * @param {Object} result
 * @param {string} result.coupon_id
 * @param {string} result.status       — 'active' | 'expired' | 'needs_manual_check'
 * @param {string} result.checked_at   — ISO timestamp
 * @param {string|null} result.error
 */
async function reportResult(result) {
  const url = `${YANDEX_API_BASE}/api/admin/parser/result`;

  const payload = {
    coupon_id:  result.coupon_id,
    status:     result.status,
    checked_at: result.checked_at,
    error:      result.error || null,
    // ★ Никаких ПД пользователей — только данные о коде
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Parser-Secret': PARSER_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[reporter] Ошибка записи результата coupon_id=${result.coupon_id}: ${response.status} ${text}`);
      return false;
    }

    console.log(`[reporter] OK coupon_id=${result.coupon_id} status=${result.status}`);
    return true;

  } catch (err) {
    console.error(`[reporter] Сетевая ошибка: ${err.message}`);
    return false;
  }
}

/**
 * Отправляем пакет результатов (batch)
 *
 * @param {Array} results — массив результатов
 */
async function reportBatch(results) {
  // Параллельно, но не более 5 одновременно — не грузим API
  const CONCURRENCY = 5;
  const chunks = [];

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    chunks.push(results.slice(i, i + CONCURRENCY));
  }

  let successCount = 0;
  let failCount = 0;

  for (const chunk of chunks) {
    const settled = await Promise.allSettled(chunk.map(r => reportResult(r)));
    settled.forEach(s => {
      if (s.status === 'fulfilled' && s.value) successCount++;
      else failCount++;
    });
  }

  console.log(`[reporter] Batch завершён: ${successCount} OK, ${failCount} ошибок`);
  return { successCount, failCount };
}

module.exports = { reportResult, reportBatch };
