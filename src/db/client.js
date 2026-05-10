// =============================================================================
// db/client.js — переиспользуемый PG pool для Yandex Cloud Functions.
//
// Pool создаётся один раз на cold-start и переиспользуется на всех warm-
// инвокациях контейнера через module-level singleton. Импорт этого модуля
// из handler.js не должен создавать pool — он создаётся лениво в getPool(),
// чтобы при тестировании можно было его не инстанциировать.
// =============================================================================

import pg from 'pg';
import { config } from '../config.js';

let pool = null;

export function getPool() {
    if (pool) return pool;

    pool = new pg.Pool({
        host:     config.pg.host,
        port:     config.pg.port,
        user:     config.pg.user,
        password: config.pg.password,
        database: config.pg.database,

        // SSL: в Yandex Managed PG обязателен. Передаём CA как строку PEM
        // из env-переменной (приходит из Lockbox через Cloud Functions env).
        ssl: config.pg.ca
            ? { rejectUnauthorized: true, ca: config.pg.ca }
            : undefined,

        // Лимиты под serverless:
        max: 1,                       // один контейнер обрабатывает один запрос за раз
        idleTimeoutMillis: 5_000,     // быстро отпускаем idle-коннект
        connectionTimeoutMillis: 3_000, // не ждать долго, лучше упасть и попасть на ретрай

        // Принудительная ротация клиента после N запросов — страховка от того,
        // что тёплый контейнер держит сломанный коннект (например, после
        // failover'а PG-мастера).
        maxUses: 1000,
    });

    // Без обработчика ошибок pool падает с unhandled error при сетевых
    // глюках. Логируем и оставляем pool жить — следующий getPool() вернёт
    // тот же объект, pg внутри сам пересоздаст клиент.
    pool.on('error', (err) => {
        console.error('[pg pool error]', err);
    });

    return pool;
}
