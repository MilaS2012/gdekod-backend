// =============================================================================
// response.js — типовые HTTP-ответы для Yandex Cloud Functions.
//
// Никогда не возвращаем stack trace клиенту — только короткое сообщение
// и requestId для саппорта. Подробности — только в console.error
// (попадает в Yandex Cloud Logging автоматически).
// =============================================================================

import { corsHeaders } from './cors.js';

function baseHeaders(origin) {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(origin),
    };
}

export function ok(body, { origin = null, headers = {} } = {}) {
    return {
        statusCode: 200,
        headers: { ...baseHeaders(origin), ...headers },
        body: JSON.stringify(body),
    };
}

export function badRequest(message, { origin = null } = {}) {
    return {
        statusCode: 400,
        headers: baseHeaders(origin),
        body: JSON.stringify({ error: message }),
    };
}

export function unauthorized(message = 'Unauthorized', { origin = null } = {}) {
    return {
        statusCode: 401,
        headers: baseHeaders(origin),
        body: JSON.stringify({ error: message }),
    };
}

export function notFound(message = 'Not found', { origin = null } = {}) {
    return {
        statusCode: 404,
        headers: baseHeaders(origin),
        body: JSON.stringify({ error: message }),
    };
}

export function methodNotAllowed({ origin = null } = {}) {
    return {
        statusCode: 405,
        headers: { ...baseHeaders(origin), 'Allow': 'GET, OPTIONS' },
        body: JSON.stringify({ error: 'Method not allowed' }),
    };
}

export function serverError({ origin = null, requestId = null } = {}) {
    return {
        statusCode: 500,
        headers: baseHeaders(origin),
        body: JSON.stringify({ error: 'Internal server error', requestId }),
    };
}

export function corsPreflight(origin) {
    return {
        statusCode: 204,
        headers: corsHeaders(origin),
        body: '',
    };
}

// -----------------------------------------------------------------------------
// Helpers общего пользования
// -----------------------------------------------------------------------------

/**
 * Достаём Origin из заголовков события (case-insensitive).
 */
export function getOrigin(event) {
    const h = event?.headers ?? {};
    return h.origin ?? h.Origin ?? null;
}

/**
 * Безопасный toISOString — если значение уже строка, возвращаем как есть.
 * Если null/undefined — возвращаем null.
 */
export function toIso(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    // pg обычно возвращает Date для timestamptz, но на всякий случай:
    return String(value);
}
