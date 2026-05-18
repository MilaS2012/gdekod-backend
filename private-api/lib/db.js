// =============================================================================
// db.js — переиспользуемый PG pool для приватного API.
//
// Pool создаётся лениво на первом обращении (на cold-start функции) и
// переиспользуется на всех warm-вызовах того же контейнера через
// module-level singleton. Импорт модуля сам по себе НЕ открывает
// соединение — это удобно для тестов.
//
// Пользователь private_api_writer имеет:
//   - RW по схеме private_data (users, sessions, tokens, subscriptions, ...)
//   - SELECT по схеме public_data (раскрытие промокодов)
// =============================================================================

import pg from 'pg';

let pool = null;

function buildPool() {
    const ssl = process.env.YANDEX_PG_CA_CERT
        ? { rejectUnauthorized: true, ca: process.env.YANDEX_PG_CA_CERT }
        : undefined;

    const p = new pg.Pool({
        host:     process.env.YANDEX_PG_HOST,
        port:     Number(process.env.YANDEX_PG_PORT ?? 6432),
        user:     process.env.YANDEX_PG_USER,
        password: process.env.YANDEX_PG_PASSWORD,
        database: process.env.YANDEX_PG_DATABASE,
        ssl,

        // serverless-настройки: один контейнер обрабатывает один запрос
        // за раз, поэтому max=1 достаточно. Pgbouncer мультиплексирует
        // тысячи логических конектов в десятки физических.
        max: 1,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 3_000,

        // Принудительная ротация клиента после N запросов — страховка
        // от подвисших коннектов после failover'а PG.
        maxUses: 1000,
    });

    p.on('error', (err) => console.error('[pg pool]', err.message));
    return p;
}

export function getPool() {
    if (!pool) pool = buildPool();
    return pool;
}

// -----------------------------------------------------------------------------
// Тестовые хуки. В production-коде НЕ использовать.
// -----------------------------------------------------------------------------

export function __setPoolForTest(mock) { pool = mock; }
export function __resetPoolForTest()   { pool = null; }
