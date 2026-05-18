// =============================================================================
// subscription-status.test.js — GET /api/subscription/status (6.6).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/subscription/status.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestSubscription,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ jwt = null, method = 'GET', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// Группа C — /subscription/status
// =============================================================================

test('11: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('12: user без подписки → active=false, subscription=null, есть available_tariffs', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.active, false);
    assert.equal(body.subscription, null);
    assert.ok(Array.isArray(body.available_tariffs));
    assert.equal(body.available_tariffs.length, 2);
    resetTestAuthSecrets();
});

test('13: user с активной подпиской → корректные поля subscription', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const sub = await createTestSubscription(pool, user_id, {
        tariff: 'daily_35', provider: 'operator_mock', status: 'active',
    });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.active, true);
    assert.equal(body.subscription.id, sub.id);
    assert.equal(body.subscription.tariff, 'daily_35');
    assert.equal(body.subscription.provider, 'operator_mock');
    assert.equal(body.subscription.status, 'active');
    assert.equal(body.subscription.amount_kopecks, 3500);
    assert.ok(body.subscription.activated_at);
    assert.ok(body.subscription.expires_at);
    resetTestAuthSecrets();
});

test('14: available_tariffs возвращает только доступные провайдеры по env', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    // NODE_ENV не задан → staging-режим
    delete process.env.NODE_ENV;

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    const daily   = body.available_tariffs.find(t => t.tariff === 'daily_35');
    const monthly = body.available_tariffs.find(t => t.tariff === 'monthly_499');
    assert.deepEqual(daily.providers,   ['operator_mock']);
    assert.deepEqual(monthly.providers, ['cloudpayments_card', 'cloudpayments_sbp']);
    resetTestAuthSecrets();
});

test('cancelled подписка с не-истёкшим access — видна в /status (active=false, subscription не null)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id, { status: 'cancelled' });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.active, false);
    assert.equal(body.subscription.status, 'cancelled');
    assert.ok(body.subscription.cancelled_at);
    resetTestAuthSecrets();
});

// HTTP
test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('POST → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'POST' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
