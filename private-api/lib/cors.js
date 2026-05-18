// =============================================================================
// cors.js — CORS-заголовки приватного API.
//
// Whitelist: только два production-домена. Origin вне списка → отдаём
// заголовок с https://gde-code.ru (fallback) — браузер всё равно
// заблокирует ответ, но мы не «случайно разрешаем» что попало в кешах
// CDN и в логах. По ТЗ v16 §19.
//
// Приватный API принимает не только GET — добавлены POST/PATCH/DELETE
// и Authorization-заголовок для JWT.
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
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        // Браузеры с credentialed-запросами (cookies/Authorization) требуют
        // явного allow-credentials. JWT идёт в Authorization-заголовке, но
        // если фронт когда-нибудь решит положить токен в cookie — поведение
        // не сломается. С credentials=true wildcard origin запрещён, у нас
        // и так whitelist.
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '3600',
        // Vary: Origin — сигнал кешам (CDN, браузер), что ответ зависит
        // от Origin и не должен переиспользоваться между разными origin'ами.
        'Vary': 'Origin',
    };
}
