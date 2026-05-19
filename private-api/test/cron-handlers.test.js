// =============================================================================
// cron-handlers.test.js — smoke-тесты для cron-обёрток (6.10).
//
// Группа F из спеки.
//
// Каждый cron-handler — тонкая обёртка над lib-функцией. Тесты проверяют:
//   - корректная передача pool через _deps (без реального PG)
//   - правильный shaped ответ { ok, ... }
//   - try/catch отрабатывает — broken pool → { ok:false, error }
//
// pg-mem quirk: FOR UPDATE SKIP LOCKED не парсится → передаём
//   _deps.skipForUpdate = true для mock-daily-charges.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as mockChargesHandler }  from '../cron/mock-daily-charges.js';
import { handler as scheduledDelHandler } from '../cron/scheduled-deletions.js';
import { handler as eventsCleanHandler }  from '../cron/events-cleanup.js';

import {
    newPgMemPool,
    createTestUser,
    setUserDeletion,
    createTestEvent,
} from './helpers.js';

// =============================================================================
// Вспомогательные функции
// =============================================================================

/** Прямой INSERT mock-подписки с next_charge_at в прошлом. */
async function insertMockSubscription(pool, user_id, { nextChargeOffsetSeconds = 60 } = {}) {
    const nextChargeAt = new Date(Date.now() - nextChargeOffsetSeconds * 1000);
    const expiresAt    = new Date(Date.now() + 86_400 * 1000);
    const { rows } = await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, expires_at, next_charge_at)
         VALUES ($1, 'daily_35', 'operator_mock', 'active', 3500,
                 now(), $2, $3)
         RETURNING id`,
        [user_id, expiresAt.toISOString(), nextChargeAt.toISOString()],
    );
    return rows[0];
}

/** Mock pool, который бросает при первом query. */
function brokenPool(message = 'DB connection failed') {
    return {
        async query() { throw new Error(message); },
    };
}

// =============================================================================
// F — cron-handlers
// =============================================================================

test('F1: mock-daily-charges пустая БД → {ok:true, processed:0}', async () => {
    const pool = await newPgMemPool();
    const r = await mockChargesHandler({}, {}, { pool, skipForUpdate: true });
    assert.deepEqual(r, { ok: true, processed: 0 });
});

test('F2: mock-daily-charges с активной mock-подпиской → {ok:true, processed:1}', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await insertMockSubscription(pool, user_id);

    const r = await mockChargesHandler({}, {}, { pool, skipForUpdate: true });
    assert.deepEqual(r, { ok: true, processed: 1 });
});

test('F3: scheduled-deletions без кандидатов → {ok:true, processed:0, deleted:0, failed:0}', async () => {
    const pool = await newPgMemPool();
    await createTestUser(pool); // user без scheduled_deletion

    const r = await scheduledDelHandler({}, {}, { pool });
    assert.deepEqual(r, { ok: true, processed: 0, deleted: 0, failed: 0 });
});

test('F4: events-cleanup без старых событий → {ok:true, deleted:0}', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // Свежее событие — НЕ должно быть удалено
    await createTestEvent(pool, user_id, { event_type: 'coupon_viewed' });

    const r = await eventsCleanHandler({}, {}, { pool });
    assert.deepEqual(r, { ok: true, deleted: 0 });
});

test('F5: events-cleanup со старым событием (181 день) → {ok:true, deleted:1}', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // 181 * 86400 = чуть больше EVENTS_RETENTION_DAYS (180)
    await createTestEvent(pool, user_id, {
        event_type: 'coupon_viewed',
        createdAtOffsetSeconds: 181 * 86_400,
    });

    const r = await eventsCleanHandler({}, {}, { pool });
    assert.deepEqual(r, { ok: true, deleted: 1 });
});

test('F6: broken pool → {ok:false, error:<string>} — try/catch работает', async () => {
    // Используем events-cleanup как наименее зависимый handler
    const r = await eventsCleanHandler({}, {}, { pool: brokenPool('connection refused') });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, 'error должен содержать описание');
});
