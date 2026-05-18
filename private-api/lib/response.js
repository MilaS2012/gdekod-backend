// =============================================================================
// response.js — типовые HTTP-ответы для Yandex Cloud Functions.
//
// Никогда не возвращаем stack trace клиенту — только короткое сообщение
// и requestId для саппорта. Подробности — только в console.error
// (попадает в Yandex Cloud Logging автоматически).
//
// Расширенный набор статусов по сравнению с public-api:
//   400 badRequest, 401 unauthorized, 403 forbidden, 404 notFound,
//   405 methodNotAllowed, 409 conflict, 410 gone, 429 tooManyRequests,
//   500 serverError, 204 corsPreflight.
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

/**
 * 403 Forbidden. Принимает либо строку, либо объект `{ error, ...details }`
 * (например, для `subscription_required` + `redirect_to`).
 */
export function forbidden(errorOrObject = 'Forbidden', { origin = null } = {}) {
    const body = typeof errorOrObject === 'string'
        ? { error: errorOrObject }
        : errorOrObject;
    return {
        statusCode: 403,
        headers: baseHeaders(origin),
        body: JSON.stringify(body),
    };
}

export function notFound(message = 'Not found', { origin = null } = {}) {
    return {
        statusCode: 404,
        headers: baseHeaders(origin),
        body: JSON.stringify({ error: message }),
    };
}

export function methodNotAllowed(allow, { origin = null } = {}) {
    const allowHeader = Array.isArray(allow) ? allow.join(', ') : String(allow ?? 'GET, OPTIONS');
    return {
        statusCode: 405,
        headers: { ...baseHeaders(origin), 'Allow': allowHeader },
        body: JSON.stringify({ error: 'Method not allowed' }),
    };
}

/**
 * 409 Conflict. Принимает либо строку (становится `{ error: <str> }`),
 * либо объект `{ error, message? }` для случаев, когда фронт должен
 * показать пользователю причину отказа (например, при попытке смены
 * verified email через attach — нужно объяснить, что делать).
 */
export function conflict(errorOrObject = 'Conflict', { origin = null } = {}) {
    const body = typeof errorOrObject === 'string'
        ? { error: errorOrObject }
        : errorOrObject;
    return {
        statusCode: 409,
        headers: baseHeaders(origin),
        body: JSON.stringify(body),
    };
}

// 410 Gone — ссылка/токен истёк или уже использован. Применяется для
// email-verify, magic-link, coupon_not_active. Принимает строку или объект.
export function gone(errorOrObject = 'Gone', { origin = null } = {}) {
    const body = typeof errorOrObject === 'string'
        ? { error: errorOrObject }
        : errorOrObject;
    return {
        statusCode: 410,
        headers: baseHeaders(origin),
        body: JSON.stringify(body),
    };
}

// 429 Too Many Requests — анти-спам лимиты. По возможности возвращаем
// Retry-After в секундах, чтобы фронт мог показать таймер.
// Принимает строку (тогда тело = { error, retry_after_seconds }) или
// объект `{ error, ...details }` (тело = объект как есть + retry_after_seconds
// если передан в opts).
export function tooManyRequests(errorOrObject = 'Too many requests', { origin = null, retryAfterSeconds = null } = {}) {
    const headers = { ...baseHeaders(origin) };
    if (retryAfterSeconds != null) headers['Retry-After'] = String(retryAfterSeconds);
    const body = typeof errorOrObject === 'string'
        ? { error: errorOrObject, retry_after_seconds: retryAfterSeconds }
        : { ...errorOrObject,
            ...(retryAfterSeconds != null ? { retry_after_seconds: retryAfterSeconds } : {}) };
    return {
        statusCode: 429,
        headers,
        body: JSON.stringify(body),
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

export function getOrigin(event) {
    const h = event?.headers ?? {};
    return h.origin ?? h.Origin ?? null;
}

// Безопасно читает JSON-тело serverless-события. На вход приходит либо
// строка (event.body), либо уже распарсенный объект (если runtime сам
// распарсил). На пустое тело возвращает {}. На невалидный JSON — null.
export function parseJsonBody(event) {
    const raw = event?.body;
    if (raw == null || raw === '') return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); }
    catch { return null; }
}

export function toIso(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}
