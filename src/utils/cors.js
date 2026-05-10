// =============================================================================
// utils/cors.js — CORS-заголовки для публичного API.
//
// Origin'ы whitelisted: только два production-домена. Если запрос пришёл
// с неразрешённого origin, отдаём заголовок с `https://gde-code.ru`
// (а не `*` и не сам неразрешённый origin) — браузер всё равно заблокирует
// ответ, но мы не «случайно разрешаем» что попало.
// =============================================================================

const ALLOWED_ORIGINS = new Set([
    'https://gde-code.ru',
    'https://www.gde-code.ru',
]);

const FALLBACK_ORIGIN = 'https://gde-code.ru';

export function isAllowedOrigin(origin) {
    return typeof origin === 'string' && ALLOWED_ORIGINS.has(origin);
}

export function corsHeaders(origin) {
    const allowed = isAllowedOrigin(origin) ? origin : FALLBACK_ORIGIN;
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age':       '3600',
        // Vary: Origin — сигнал кешам (CDN, браузер), что ответ зависит
        // от заголовка Origin и не должен переиспользоваться между origin'ами.
        'Vary': 'Origin',
    };
}
