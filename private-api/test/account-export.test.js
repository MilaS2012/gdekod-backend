// =============================================================================
// account-export.test.js — POST /api/account/export (6.9, 152-ФЗ ст. 14).
//
// Группа A из спеки. Полные (не маскированные!) данные, Content-Disposition,
// rate-limit 1/час через events_log.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/account/export.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestMerchant,
    createTestCoupon,
    createTestSubscription,
    createTestTicket,
    createTestEvent,
    markUserEmailVerified,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

function makeEvent({ jwt = null, method = 'POST' } = {}) {
    return {
        httpMethod: method,
        headers: { origin: 'https://gde-code.ru',
                   ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool) {
    const { user_id, phone } = await createTestUser(pool);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, phone, jwt };
}

// =============================================================================
// A — /account/export
// =============================================================================

test('A1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('A2: 200 с application/json + Content-Disposition attachment', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['Content-Type'], /application\/json/);
    assert.match(r.headers['Content-Disposition'],
                 /^attachment; filename="gdekod-data-\d{8}\.json"$/);
    resetTestAuthSecrets();
});

test('A3: JSON содержит все 7 секций', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.export_format_version, '1.0');
    assert.ok(typeof body.exported_at === 'string');
    assert.ok(body.profile);
    assert.ok(Array.isArray(body.subscriptions));
    assert.ok(Array.isArray(body.receipts));
    assert.ok(Array.isArray(body.coupons_revealed));
    assert.ok(Array.isArray(body.votes));
    assert.ok(Array.isArray(body.active_sessions));
    assert.ok(Array.isArray(body.support_tickets));
    resetTestAuthSecrets();
});

test('A4: profile.phone — ПОЛНЫЙ (не маскированный)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, phone, jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.profile.phone, phone, 'phone не должен маскироваться в экспорте');
    assert.equal(body.profile.id, user_id);
    resetTestAuthSecrets();
});

test('A5: пустой аккаунт — все массивы []', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.deepEqual(body.subscriptions, []);
    assert.deepEqual(body.receipts, []);
    assert.deepEqual(body.coupons_revealed, []);
    assert.deepEqual(body.votes, []);
    // active_sessions содержит текущую — она НЕ пустая, что ожидаемо.
    assert.equal(body.active_sessions.length, 1);
    assert.deepEqual(body.support_tickets, []);
    resetTestAuthSecrets();
});

test('A6: заполненный аккаунт — все массивы с данными', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await markUserEmailVerified(pool, user_id, 'mila@example.com');
    await createTestSubscription(pool, user_id, { tariff: 'daily_35' });
    const merchant = await createTestMerchant(pool, { domain: 'wb.ru' });
    const coupon = await createTestCoupon(pool, { merchant_id: merchant.id });
    await pool.query(
        `INSERT INTO private_data.coupon_reveals (user_id, coupon_id)
         VALUES ($1, $2)`,
        [user_id, coupon.id],
    );
    await pool.query(
        `INSERT INTO private_data.coupon_votes (user_id, coupon_id, vote_type)
         VALUES ($1, $2, 'confirm')`,
        [user_id, coupon.id],
    );
    await createTestTicket(pool, user_id, { subject: 'help', category: 'other' });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.profile.email, 'mila@example.com');
    assert.equal(body.subscriptions.length, 1);
    assert.equal(body.coupons_revealed.length, 1);
    assert.equal(body.votes.length, 1);
    assert.equal(body.support_tickets.length, 1);
    // Содержимое тикета (subject + message) В экспорте есть — это его право.
    assert.equal(body.support_tickets[0].subject, 'help');
    resetTestAuthSecrets();
});

test('A7: успешный export пишет events_log с event_type=data_exported', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const { rows } = await pool.query(
        `SELECT event_type FROM private_data.events_log WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'data_exported');
    resetTestAuthSecrets();
});

test('A8: rate-limit 1/час → второй вызов 429 too_many_exports', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // Сразу кладём events_log с data_exported (свежий, в окне часа).
    await createTestEvent(pool, user_id, { event_type: 'data_exported' });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).error, 'too_many_exports');
    resetTestAuthSecrets();
});

test('A9: GET → 405 methodNotAllowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('A10: OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});
