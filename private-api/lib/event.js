// =============================================================================
// event.js — извлечение метаданных запроса из Cloud Functions event.
//
// Yandex Cloud Functions через API Gateway пробрасывает реальный IP в
// event.requestContext.identity.sourceIp. На случай других путей (внутренний
// прокси, тестовый клиент) поддерживается fallback на X-Forwarded-For.
// =============================================================================

import { createHash } from 'node:crypto';

/**
 * Извлекает source IP из event. Приоритет:
 *   1. event.requestContext.identity.sourceIp (Yandex API Gateway)
 *   2. X-Forwarded-For (первый адрес — реальный клиент)
 *   3. null, если ничего не нашли
 */
export function extractIp(event) {
    const ctx = event?.requestContext?.identity?.sourceIp;
    if (typeof ctx === 'string' && ctx.length > 0) return ctx;

    const h = event?.headers ?? {};
    const xff = h['x-forwarded-for'] ?? h['X-Forwarded-For'];
    if (typeof xff === 'string' && xff.length > 0) {
        return xff.split(',')[0].trim();
    }
    return null;
}

/**
 * Достаёт User-Agent (case-insensitive header). Возвращает строку или null.
 */
export function extractUserAgent(event) {
    const h = event?.headers ?? {};
    const ua = h['user-agent'] ?? h['User-Agent'];
    return typeof ua === 'string' && ua.length > 0 ? ua : null;
}

/**
 * SHA-256(UA) hex (64 символа). Этот хеш храним в auth_sessions, не сам UA
 * — UA это PII-light, можно деанонимизировать. При показе списка устройств
 * парсим хеш обратно в "Chrome on macOS" на лету через ua-parser-js.
 *
 * Для null/пустого UA возвращает null.
 */
export function userAgentHash(ua) {
    if (typeof ua !== 'string' || ua.length === 0) return null;
    return createHash('sha256').update(ua).digest('hex');
}
