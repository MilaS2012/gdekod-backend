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
 * SHA-256(UA) hex (64 символа). Этот хеш храним в auth_sessions для
 * PII-защищённой идентификации устройства (оповещение о смене UA).
 *
 * Для null/пустого UA возвращает null.
 */
export function userAgentHash(ua) {
    if (typeof ua !== 'string' || ua.length === 0) return null;
    return createHash('sha256').update(ua).digest('hex');
}

/**
 * Парсит UA в человекочитаемую метку для UI ("Chrome 120 on macOS").
 * Кладётся в auth_sessions.user_agent_summary (VARCHAR(100)).
 *
 * Порядок проверок критичен:
 *   - YaBrowser / Edg ПЕРЕД Chrome (UA содержит "Chrome" внутри)
 *   - Safari через Version/X — иначе ложно срабатывает на Chrome (имеет "Safari/X")
 *   - iPhone / iPad ПЕРЕД Android (специфичнее)
 *
 * Возвращает 'Unknown device' для пустого/нестрокового UA.
 * Длина результата гарантированно ≤ 100 символов.
 */
export function parseUserAgent(ua) {
    if (typeof ua !== 'string' || ua.length === 0) return 'Unknown device';

    let browser = 'Browser';
    let m;
    if      ((m = ua.match(/YaBrowser\/(\d+)/)))                browser = `Yandex ${m[1]}`;
    else if ((m = ua.match(/Edg\/(\d+)/)))                      browser = `Edge ${m[1]}`;
    else if ((m = ua.match(/Chrome\/(\d+)/)))                   browser = `Chrome ${m[1]}`;
    else if ((m = ua.match(/Firefox\/(\d+)/)))                  browser = `Firefox ${m[1]}`;
    else if ((m = ua.match(/Version\/(\d+)[^)]*Safari/)))       browser = `Safari ${m[1]}`;

    let os = 'OS';
    if      (/iPhone/.test(ua))         os = 'iPhone';
    else if (/iPad/.test(ua))           os = 'iPad';
    else if (/Android/.test(ua))        os = 'Android';
    else if (/Windows NT 11/.test(ua))  os = 'Windows 11';
    else if (/Windows NT 10/.test(ua))  os = 'Windows 10';
    else if (/Mac OS X/.test(ua))       os = 'macOS';
    else if (/Linux/.test(ua))          os = 'Linux';

    const summary = `${browser} on ${os}`;
    return summary.length > 100 ? summary.slice(0, 100) : summary;
}
