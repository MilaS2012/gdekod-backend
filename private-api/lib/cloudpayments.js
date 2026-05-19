// =============================================================================
// cloudpayments.js — хелперы для интеграции с CloudPayments (этап 7).
//
// Используется в:
//   - handlers/subscription/start.js — для widget_config (publicId, amount)
//   - handlers/webhook/cloudpayments/{pay,recurrent,fail}.js — проверка HMAC,
//     маппинг статусов
//
// ★ API ключи (PUBLIC_ID, API_SECRET, WEBHOOK_SECRET) НИКОГДА не логируются
//   и не появляются в коде. Только через process.env.
// ★ verifyWebhookHmac — timing-safe сравнение через crypto.timingSafeEqual
//   для защиты от timing-attack на содержимое подписи.
// =============================================================================

import crypto from 'node:crypto';

/**
 * Проверяет HMAC-SHA256 подпись webhook'а CloudPayments.
 *
 * CloudPayments подписывает RAW body через HMAC-SHA256 + base64 с секретом
 * из настроек уведомлений. Подпись передаётся в заголовке `Content-HMAC`.
 *
 * Контракт: secret обязателен в env — без него throws (не return false,
 * чтобы конфигурационная ошибка не маскировалась под «неверная подпись»
 * и не приводила к беззвучному отказу обработки webhook'ов).
 *
 * @param {string} rawBody       — точный raw body запроса (JSON-строка)
 * @param {string} receivedHmac  — значение заголовка Content-HMAC
 * @returns {boolean} true если подпись валидна
 * @throws {Error} если CLOUDPAYMENTS_WEBHOOK_SECRET не задан в env
 */
export function verifyWebhookHmac(rawBody, receivedHmac) {
    const secret = process.env.CLOUDPAYMENTS_WEBHOOK_SECRET;
    if (!secret) {
        throw new Error('CLOUDPAYMENTS_WEBHOOK_SECRET not set');
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody ?? '')
        .digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(receivedHmac ?? '');

    // timingSafeEqual требует одинаковой длины. Возвращаем false ДО вызова,
    // чтобы не выкинуть RangeError и одновременно не дать timing-leak на
    // длину (длина подписи фиксированная — 44 символа base64 для sha256).
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Маппинг статуса CloudPayments в наш subscription.status.
 *
 * CloudPayments-статусы (для webhook payload.Status):
 *   - 'Completed'  — успешное списание
 *   - 'Authorized' — авторизовано (двухэтапная схема, не используется в MVP)
 *   - 'Declined'   — карта не прошла (недостаточно средств, лимит, etc.)
 *   - 'Cancelled'  — отменено user'ом или мерчантом
 *
 * Любой другой статус → 'unknown'. В webhook handler такие статусы
 * логируются как WARN и не меняют состояние подписки.
 *
 * @param {string} cpStatus
 * @returns {'active'|'pending'|'failed'|'unknown'}
 */
export function mapCpStatus(cpStatus) {
    const map = {
        Completed:  'active',
        Authorized: 'pending',
        Declined:   'failed',
        Cancelled:  'failed',
    };
    return map[cpStatus] ?? 'unknown';
}

/**
 * Конвертация копеек в рубли. CloudPayments Widget API ожидает amount
 * как число в рублях (499.00), наш TARIFFS хранит amount_kopecks (49900).
 *
 * @param {number} kopecks
 * @returns {number} amount в рублях с точностью до 2 знаков
 */
export function kopecksToRubles(kopecks) {
    return kopecks / 100;
}
