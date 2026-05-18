// =============================================================================
// subscription-cancel.test.js — POST /api/subscription/cancel (6.6).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as cancelHandler } from '../handlers/subscription/cancel.js';
import { handler as startHandler  } from '../handlers/subscription/start.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestSubscription,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ body = null, jwt = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        body: body == null ? '' : JSON.stringify(body),
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// Группа G — /subscription/cancel
// =============================================================================

test('26: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await cancelHandler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('27: нет активной подписки → 404 no_active_subscription', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 404);
    assert.equal(parseBody(r).error, 'no_active_subscription');
    resetTestAuthSecrets();
});

test('28: cancel активной → status="cancelled", cancelled_at заполнен', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const sub = await createTestSubscription(pool, user_id, { status: 'active' });

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.subscription_id, sub.id);
    assert.equal(body.status, 'cancelled');

    const inDb = (await pool.query(
        `SELECT status, cancelled_at, next_charge_at FROM private_data.subscriptions WHERE id = $1`,
        [sub.id])).rows[0];
    assert.equal(inDb.status, 'cancelled');
    assert.ok(inDb.cancelled_at != null);
    assert.equal(inDb.next_charge_at, null, 'next_charge_at должно быть NULL после cancel');
    resetTestAuthSecrets();
});

test('29: после cancel access_until = expires_at (доступ сохраняется)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const sub = await createTestSubscription(pool, user_id, { status: 'active' });

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.ok(body.access_until);
    // access_until должно быть равно изначальному expires_at
    const expectedExpires = new Date(sub.expires_at).toISOString();
    assert.equal(body.access_until, expectedExpires);
    resetTestAuthSecrets();
});

test('30: после cancel /start новой подписки работает (без 409)', async () => {
    setTestAuthSecrets();
    delete process.env.NODE_ENV;
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id, { status: 'active' });

    // Cancel первую
    await cancelHandler(makeEvent({ jwt }), {}, { pool });

    // Start вторую — должно пройти
    const r = await startHandler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_mock' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).status, 'active');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await cancelHandler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await cancelHandler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
