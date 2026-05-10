/**
 * ГдеКод — Queue
 * Очередь реактивных перепроверок.
 * Когда пользователь нажимает «Не сработал» → жалоба попадает в БД.
 * При достижении порога (3 жалобы за час) → задача в эту очередь.
 *
 * В MVP используем in-memory очередь + polling из Yandex API.
 * В будущем можно заменить на Azure Service Bus.
 */

const { checkCoupon }  = require('./checker');
const { reportResult } = require('./reporter');

const YANDEX_API_BASE = process.env.YANDEX_API_URL || 'https://api.gde-code.ru';
const PARSER_SECRET   = process.env.PARSER_SECRET_KEY;

// In-memory очередь срочных задач (между тиковыми запусками)
const urgentQueue = new Set();

/**
 * Добавляем задачу в очередь срочной проверки
 * @param {string} couponId
 */
function addUrgent(couponId) {
  urgentQueue.add(couponId);
  console.log(`[queue] Добавлена срочная проверка coupon_id=${couponId} (в очереди: ${urgentQueue.size})`);
}

/**
 * Получаем из Yandex API список coupon_id, требующих срочной проверки
 * (те, у которых 3+ жалобы за последний час)
 *
 * @returns {Promise<Array<string>>} массив coupon_id
 */
async function fetchUrgentFromApi() {
  try {
    const response = await fetch(`${YANDEX_API_BASE}/api/admin/parser/urgent-queue`, {
      headers: { 'X-Parser-Secret': PARSER_SECRET },
    });

    if (!response.ok) return [];

    const data = await response.json();
    return data.coupon_ids || [];

  } catch {
    return [];
  }
}

/**
 * Получаем из Yandex API полные данные промокода для проверки
 * @param {string} couponId
 */
async function fetchCouponConfig(couponId) {
  try {
    const response = await fetch(`${YANDEX_API_BASE}/api/admin/parser/coupon/${couponId}`, {
      headers: { 'X-Parser-Secret': PARSER_SECRET },
    });

    if (!response.ok) return null;
    return await response.json();

  } catch {
    return null;
  }
}

/**
 * Обрабатываем очередь срочных перепроверок
 * Запускается после каждого tier-батча и отдельно каждые 5 минут
 */
async function processUrgentQueue() {
  // Берём из API + из in-memory
  const fromApi = await fetchUrgentFromApi();
  fromApi.forEach(id => urgentQueue.add(id));

  if (urgentQueue.size === 0) {
    return;
  }

  console.log(`[queue] Обработка срочной очереди: ${urgentQueue.size} задач`);

  const toProcess = [...urgentQueue];
  urgentQueue.clear();

  for (const couponId of toProcess) {
    const couponConfig = await fetchCouponConfig(couponId);

    if (!couponConfig) {
      console.warn(`[queue] Не удалось получить конфиг для coupon_id=${couponId}`);
      continue;
    }

    console.log(`[queue] Срочная проверка coupon_id=${couponId}`);
    const result = await checkCoupon(couponConfig);
    await reportResult(result);

    // Небольшая пауза между проверками
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[queue] Срочная очередь обработана`);
}

module.exports = { addUrgent, processUrgentQueue };
