// =============================================================================
// events-cleanup.test.js — lib/events-cleanup.js (6.11).
//
// Группа D из спеки 6.11. Retention 180 дней — старые DELETE, свежие
// остаются. Cutoff считаем в JS, поэтому покрытие самой границы (-180 дней)
// детерминировано.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupOldEvents } from '../lib/events-cleanup.js';
import { EVENTS_RETENTION_DAYS } from '../lib/events-config.js';
import {
    newPgMemPool,
    createTestUser,
    createTestEvent,
} from './helpers.js';

const DAY_S = 24 * 60 * 60;

test('D1: без старых событий → возвращает 0, ничего не трогает', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // 3 свежих события
    await createTestEvent(pool, user_id, { event_type: 'coupon_viewed' });
    await createTestEvent(pool, user_id, { event_type: 'page_viewed' });
    await createTestEvent(pool, user_id, { event_type: 'search_performed' });

    const deleted = await cleanupOldEvents({ pool });
    assert.equal(deleted, 0);

    const { rows } = await pool.query(
        `SELECT count(*)::int AS c FROM private_data.events_log`
    );
    assert.equal(rows[0].c, 3);
});

test('D2: 5 старых (>180 дней) — удаляются все', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // +1 день запаса, чтобы граница точно попала за cutoff
    const old = (EVENTS_RETENTION_DAYS + 1) * DAY_S;
    for (let i = 0; i < 5; i++) {
        await createTestEvent(pool, user_id, { createdAtOffsetSeconds: old + i });
    }
    const deleted = await cleanupOldEvents({ pool });
    assert.equal(deleted, 5);
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.events_log`
    )).rows[0].c;
    assert.equal(c, 0);
});

test('D3: 5 свежих (<180 дней) — не трогает', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // 30 дней — далеко от границы
    for (let i = 0; i < 5; i++) {
        await createTestEvent(pool, user_id, { createdAtOffsetSeconds: 30 * DAY_S + i });
    }
    const deleted = await cleanupOldEvents({ pool });
    assert.equal(deleted, 0);
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.events_log`
    )).rows[0].c;
    assert.equal(c, 5);
});

test('D4: mixed (3 старых + 2 свежих) — удаляет только 3 старых', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const old   = (EVENTS_RETENTION_DAYS + 1) * DAY_S;
    const fresh = 10 * DAY_S;
    await createTestEvent(pool, user_id, { event_type: 'page_viewed',   createdAtOffsetSeconds: old + 0 });
    await createTestEvent(pool, user_id, { event_type: 'coupon_viewed', createdAtOffsetSeconds: old + 1 });
    await createTestEvent(pool, user_id, { event_type: 'page_viewed',   createdAtOffsetSeconds: old + 2 });
    await createTestEvent(pool, user_id, { event_type: 'coupon_viewed', createdAtOffsetSeconds: fresh });
    await createTestEvent(pool, user_id, { event_type: 'page_viewed',   createdAtOffsetSeconds: 0 });

    const deleted = await cleanupOldEvents({ pool });
    assert.equal(deleted, 3);
    // Остаются только свежие (≤ 30 дней).
    const remaining = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.events_log`
    )).rows[0].c;
    assert.equal(remaining, 2);
});

test('D5: cutoff именно EVENTS_RETENTION_DAYS — граница «179 дней — оставить, 181 — удалить»', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // 179 дней — свежее cutoff, должно остаться.
    await createTestEvent(pool, user_id, {
        event_type: 'page_viewed',
        createdAtOffsetSeconds: (EVENTS_RETENTION_DAYS - 1) * DAY_S,
    });
    // 181 день — старше cutoff, должно удалиться.
    await createTestEvent(pool, user_id, {
        event_type: 'coupon_viewed',
        createdAtOffsetSeconds: (EVENTS_RETENTION_DAYS + 1) * DAY_S,
    });

    const deleted = await cleanupOldEvents({ pool });
    assert.equal(deleted, 1);

    const { rows } = await pool.query(
        `SELECT event_type FROM private_data.events_log`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'page_viewed', 'должен остаться 179-дневный');
});
