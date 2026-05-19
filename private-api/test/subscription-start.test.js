// =============================================================================
// subscription-start.test.js — POST /api/subscription/start (6.6).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/subscription/start.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestSubscription,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ body, jwt = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
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
// Группа D — /subscription/start operator_mock
// =============================================================================

test('15: tariff=daily_35 + operator_mock → 200, active, receipt is_mock=true', async () => {
    setTestAuthSecrets();
    delete process.env.NODE_ENV;  // staging
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_mock' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.ok(body.subscription_id);
    assert.equal(body.status, 'active');
    assert.ok(body.activated_at);
    assert.ok(body.expires_at);

    // Receipt создан с is_mock=true
    const receipts = (await pool.query(
        `SELECT amount_kopecks, is_mock, provider FROM private_data.receipts WHERE user_id = $1`,
        [user_id])).rows;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].is_mock, true);
    assert.equal(receipts[0].provider, 'operator_mock');
    assert.equal(receipts[0].amount_kopecks, 3500);
    resetTestAuthSecrets();
});

test('16: invalid tariff → 400 invalid_tariff', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ body: { tariff: 'unknown', provider: 'operator_mock' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_tariff');
    resetTestAuthSecrets();
});

test('17: invalid provider для tariff → 400 provider_not_available', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    // daily_35 + cloudpayments_card — кросс-комбинация
    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'cloudpayments_card' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'provider_not_available');
    resetTestAuthSecrets();
});

test('18: кросс tariff×provider monthly_499 + operator_mock → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(
        makeEvent({ body: { tariff: 'monthly_499', provider: 'operator_mock' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'provider_not_available');
    resetTestAuthSecrets();
});

test('19: уже есть активная подписка → 409 already_subscribed', async () => {
    setTestAuthSecrets();
    delete process.env.NODE_ENV;
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const existing = await createTestSubscription(pool, user_id, { status: 'active' });

    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_mock' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 409);
    const body = parseBody(r);
    assert.equal(body.error, 'already_subscribed');
    assert.equal(body.existing_subscription_id, existing.id);
    resetTestAuthSecrets();
});

test('20: после старта next_charge_at = activated_at + 1 день для daily_35', async () => {
    setTestAuthSecrets();
    delete process.env.NODE_ENV;
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_mock' }, jwt }),
        {}, { pool });

    const sub = (await pool.query(
        `SELECT activated_at, next_charge_at FROM private_data.subscriptions WHERE user_id = $1`,
        [user_id])).rows[0];
    const diff = new Date(sub.next_charge_at).getTime() - new Date(sub.activated_at).getTime();
    const diffHours = Math.round(diff / (3600 * 1000));
    assert.equal(diffHours, 24);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа E — /subscription/start cloudpayments
// =============================================================================

// Тесты 21-23 обновлены под этап 7: STUB_TODO_STAGE_7 заменён на widget_config.
// Детальная проверка widget_config — в subscription-start-cp.test.js (группа E).
test('21: tariff=monthly_499 + cloudpayments_card → pending + widget_config', async () => {
    setTestAuthSecrets();
    process.env.CLOUDPAYMENTS_PUBLIC_ID = 'test_pk_xyz';
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ body: { tariff: 'monthly_499', provider: 'cloudpayments_card' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.ok(body.subscription_id);
    assert.equal(body.status, 'pending');
    assert.equal(body.next_step, 'open_cloudpayments_widget');
    assert.ok(body.widget_config, 'widget_config должен быть в ответе');

    delete process.env.CLOUDPAYMENTS_PUBLIC_ID;
    resetTestAuthSecrets();
});

test('22: widget_config содержит invoiceId = subscription_id', async () => {
    setTestAuthSecrets();
    process.env.CLOUDPAYMENTS_PUBLIC_ID = 'test_pk_xyz';
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(
        makeEvent({ body: { tariff: 'monthly_499', provider: 'cloudpayments_card' }, jwt }),
        {}, { pool });
    const body = parseBody(r);
    assert.equal(body.widget_config.invoiceId, body.subscription_id);

    delete process.env.CLOUDPAYMENTS_PUBLIC_ID;
    resetTestAuthSecrets();
});

test('23: cloudpayments → в БД status="pending"', async () => {
    setTestAuthSecrets();
    process.env.CLOUDPAYMENTS_PUBLIC_ID = 'test_pk_xyz';
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const r = await handler(
        makeEvent({ body: { tariff: 'monthly_499', provider: 'cloudpayments_sbp' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 200, `handler вернул ${r.statusCode}: ${r.body}`);
    const rows = (await pool.query(
        `SELECT status, provider FROM private_data.subscriptions WHERE user_id = $1`,
        [user_id])).rows;
    assert.equal(rows.length, 1, 'должна быть ровно одна subscription');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].provider, 'cloudpayments_sbp');

    delete process.env.CLOUDPAYMENTS_PUBLIC_ID;
    resetTestAuthSecrets();
});

// =============================================================================
// Группа F — operator_real
// =============================================================================

test('24: tariff=daily_35 + operator_megafon на staging → 400 provider_not_available', async () => {
    setTestAuthSecrets();
    delete process.env.NODE_ENV;  // staging
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_megafon' }, jwt }),
        {}, { pool });
    // На staging operator_megafon не в списке доступных → блокируется isProviderAllowedForTariff
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'provider_not_available');
    resetTestAuthSecrets();
});

test('25: tariff=daily_35 + operator_megafon в PRODUCTION → 200 pending + wait_for_operator_sms', async () => {
    setTestAuthSecrets();
    process.env.NODE_ENV = 'production';
    process.env.MOCK_OPERATOR_BILLING = 'false';
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_megafon' }, jwt }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.status, 'pending');
    assert.equal(body.next_step, 'wait_for_operator_sms');
    delete process.env.NODE_ENV;
    delete process.env.MOCK_OPERATOR_BILLING;
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(
        makeEvent({ body: { tariff: 'daily_35', provider: 'operator_mock' } }),
        {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
