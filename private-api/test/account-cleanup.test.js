// =============================================================================
// account-cleanup.test.js — lib/account-cleanup.js processScheduledDeletions (6.9).
//
// Группа E из спеки. Идемпотентность через атомарный claim
// (deletion_completed_at = now() в WHERE — другой инстанс не подхватит).
// Resilience — ошибка одного user'а не валит партию.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { processScheduledDeletions } from '../lib/account-cleanup.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setUserDeletion,
    createTestSubscription,
    createTestEvent,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

// =============================================================================
// E — account-cleanup
// =============================================================================

test('E1: нет scheduled deletions → processed=0', async () => {
    const pool = await newPgMemPool();
    await createTestUser(pool);
    await createTestUser(pool);

    const r = await processScheduledDeletions({ pool });
    assert.deepEqual(r, { processed: 0, deleted: 0, failed: 0 });
});

test('E2: 5 user\'ов с истекшим grace → все удалены', async () => {
    const pool = await newPgMemPool();
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const { user_id } = await createTestUser(pool);
        await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 + i });
        ids.push(user_id);
    }

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.processed, 5);
    assert.equal(r.deleted, 5);
    assert.equal(r.failed, 0);

    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.users WHERE id = ANY($1)`,
        [ids],
    )).rows[0].c;
    assert.equal(c, 0);
});

test('E3: 5 user\'ов с активным grace (в будущем) → не трогает', async () => {
    const pool = await newPgMemPool();
    for (let i = 0; i < 5; i++) {
        const { user_id } = await createTestUser(pool);
        // scheduled_at в БУДУЩЕМ (отрицательный offset).
        await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: -3600 });
    }

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.processed, 0);
    assert.equal(r.deleted, 0);

    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.users`
    )).rows[0].c;
    assert.equal(c, 5, 'все user\'ы должны остаться');
});

test('E4: связанные данные удалены CASCADE (subscriptions, sessions, и т.д.)', async () => {
    setTestAuthSecrets();  // createTestSession внутри подписывает JWT — нужен секрет
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await createTestSession(pool, user_id);
    await createTestSubscription(pool, user_id, { tariff: 'daily_35' });
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 });

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.deleted, 1);

    // Прямые проверки CASCADE по таблицам, ссылающимся на users.
    for (const table of [
        'auth_sessions', 'subscriptions',
        'email_verify_tokens', 'magic_link_tokens',
        'coupon_reveals', 'coupon_votes',
        'support_tickets', 'receipts', 'account_deletion_otp_codes',
    ]) {
        const c = (await pool.query(
            `SELECT count(*)::int AS c FROM private_data.${table} WHERE user_id = $1`,
            [user_id],
        )).rows[0].c;
        assert.equal(c, 0, `${table} должна быть очищена CASCADE`);
    }
    resetTestAuthSecrets();
});

test('E5: events_log SET NULL — user_id обнуляется, событие остаётся', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await createTestEvent(pool, user_id, { event_type: 'coupon_viewed' });
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 });

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.deleted, 1);

    // Событие 'coupon_viewed' осталось (с user_id=NULL) ПЛЮС cleanup добавил
    // 'deletion_completed' (тоже с user_id=NULL после CASCADE).
    const all = (await pool.query(
        `SELECT event_type, user_id FROM private_data.events_log`
    )).rows;
    assert.ok(all.length >= 2);
    assert.ok(all.every(r => r.user_id == null),
              'все user_id должны быть NULL после ON DELETE SET NULL');
    assert.ok(all.find(r => r.event_type === 'coupon_viewed'),
              'старое событие coupon_viewed сохранено');
    assert.ok(all.find(r => r.event_type === 'deletion_completed'),
              'audit-событие deletion_completed создано');
});

test('E6: phone освобождается для нового user\'а после полного удаления', async () => {
    const pool = await newPgMemPool();
    const phone = '+79261234567';
    const { user_id: oldId } = await createTestUser(pool, phone);
    await setUserDeletion(pool, oldId, { scheduledAtOffsetSeconds: 3600 });
    await processScheduledDeletions({ pool });

    // Тот же phone — INSERT нового user'а должен пройти.
    const { rows } = await pool.query(
        `INSERT INTO private_data.users (phone) VALUES ($1) RETURNING id`,
        [phone],
    );
    assert.ok(rows[0].id !== oldId, 'новый user_id отличается от старого');
});

test('E7: повторный вызов processScheduledDeletions — idempotent, 0 без exception', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 });

    const r1 = await processScheduledDeletions({ pool });
    assert.equal(r1.deleted, 1);

    // Второй вызов: user уже удалён → candidates пуст → processed=0.
    const r2 = await processScheduledDeletions({ pool });
    assert.deepEqual(r2, { processed: 0, deleted: 0, failed: 0 });
});

test('E8: «застрявший» user (completed_at != NULL без DELETE) НЕ подхватывается', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // Симулируем сценарий «cron упал между claim и DELETE»:
    // scheduled в прошлом, completed выставлен, но row жива.
    await setUserDeletion(pool, user_id,
                          { scheduledAtOffsetSeconds: 3600, completed: true });

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.processed, 0,
                 'partial-индекс idx_users_deletion_scheduled исключает completed != NULL');

    // User остался — нужен ручной разбор админом.
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.users WHERE id = $1`,
        [user_id],
    )).rows[0].c;
    assert.equal(c, 1);
});

test('E9: смешанный батч — 3 истёкших + 2 в будущем — удаляет 3', async () => {
    const pool = await newPgMemPool();
    const expiredIds = [];
    for (let i = 0; i < 3; i++) {
        const { user_id } = await createTestUser(pool);
        await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 + i });
        expiredIds.push(user_id);
    }
    for (let i = 0; i < 2; i++) {
        const { user_id } = await createTestUser(pool);
        await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: -3600 });
    }

    const r = await processScheduledDeletions({ pool });
    assert.equal(r.processed, 3);
    assert.equal(r.deleted, 3);

    const remaining = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.users`
    )).rows[0].c;
    assert.equal(remaining, 2, 'остаются 2 user\'а с активным grace');
});
