// =============================================================================
// utils/response.js — формирование HTTP-ответа Yandex Cloud Functions.
//
// Yandex Cloud Functions ожидают объект вида:
//   { statusCode: number, headers: object, body: string, isBase64Encoded?: bool }
//
// Все ответы — JSON с CORS-заголовками. Никогда не отдаём stack trace и
// детали ошибки клиенту: только короткое сообщение и requestId для саппорта.
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
        body: JSON.stringify({
            error: 'Internal server error',
            // Клиент видит только requestId — этого достаточно, чтобы саппорт
            // нашёл соответствующую запись в YC Logging. Stack trace и
            // подробности — только в логе через console.error.
            requestId,
        }),
    };
}

export function corsPreflightResponse(origin) {
    return {
        statusCode: 204,
        headers: corsHeaders(origin),
        body: '',
    };
}
