// =============================================================================
// config.js — единая точка чтения env-переменных.
//
// Падаем громко на первом же импорте, если что-то критичное не задано:
// в serverless проще диагностировать «функция не запустилась с ошибкой
// конфига», чем «функция работает, но запросы к БД молча зависают».
// =============================================================================

const REQUIRED = [
    'YANDEX_PG_HOST',
    'YANDEX_PG_PORT',
    'YANDEX_PG_USER',
    'YANDEX_PG_PASSWORD',
    'YANDEX_PG_DATABASE',
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
    // Бросаем на module-init, до создания pool — Cloud Function упадёт
    // сразу с понятным сообщением в логах.
    throw new Error(
        `Отсутствуют обязательные env-переменные: ${missing.join(', ')}. ` +
        `См. .env.example.`,
    );
}

const port = Number(process.env.YANDEX_PG_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`YANDEX_PG_PORT="${process.env.YANDEX_PG_PORT}" — невалидный порт.`);
}

export const config = {
    pg: {
        host: process.env.YANDEX_PG_HOST,
        port,
        user: process.env.YANDEX_PG_USER,
        password: process.env.YANDEX_PG_PASSWORD,
        database: process.env.YANDEX_PG_DATABASE,
        // CA необязателен для локального Postgres без TLS, но обязателен для
        // Yandex Managed PG. Подаётся как PEM-содержимое в env-переменной.
        ca: process.env.YANDEX_PG_CA_CERT || null,
    },
    logLevel: process.env.LOG_LEVEL || 'info',
};
