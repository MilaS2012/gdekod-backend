// =============================================================================
// subscription-start-cp.test.js — POST /api/subscription/start с провайдерами
// cloudpayments_card / cloudpayments_sbp (этап 7).
//
// Группа E из спеки. Проверяем что STUB_TODO_STAGE_7 заменён на widget_config:
//   - publicId берётся из process.env.CLOUDPAYMENTS_PUBLIC_ID
//   - invoiceId = созданный subscription_id (UUID)
//   - amount в рублях (499), не копейках (49900)
//   - STUB_TODO_STAGE_7 больше НЕ в ответе
//   - Без env → 500 (fail-loud вместо silent broken widget)
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/subscription/start.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';
const TEST_PUBLIC_ID = 'test_pk_abcdef123';

function makeEvent({ body, jwt = null, origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: 'POST',
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        body: body == null ? '' : JSON.stringify(body),
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool) {
    const { user_id } = await createTestUser(pool, PHONE);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

const savedPublicId = process.env.CLOUDPAYMENTS_PUBLIC_ID;
function setPublicId(v) {
    if (v == null) delete process.env.CLOUDPAYMENTS_PUBLIC_ID;
    else           process.env.CLOUDPAYMENTS_PUBLIC_ID = v;
}
function restoreEnv() {
    if (savedPublicId === undefined) delete process.env.CLOUDPAYMENTS_PUBLIC_ID;
    else                              process.env.CLOUDPAYMENTS_PUBLIC_ID = savedPublicId;
}

// =============================================================================
// E — subscription/start с cloudpayments
// =============================================================================

test('E1: cloudpayments_card → widget_config в ответе, status=pending', async () => {
    setTestAuthSecrets();
    setPublicId(TEST_PUBLIC_ID);
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ jwt, body: { tariff: 'monthly_499', provider: 'cloudpayments_card' } }),
        {},
        { pool },
    );
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.status,    'pending');
    assert.equal(body.next_step, 'open_cloudpayments_widget');
    assert.ok(body.widget_config, 'widget_config должен быть в ответе');
    assert.equal(body.widget_config.skin,     'modern');
    assert.equal(body.widget_config.currency, 'RUB');

    restoreEnv();
    resetTestAuthSecrets();
});

test('E2: publicId берётся из process.env.CLOUDPAYMENTS_PUBLIC_ID', async () => {
    setTestAuthSecrets();
    setPublicId(TEST_PUBLIC_ID);
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ jwt, body: { tariff: 'monthly_499', provider: 'cloudpayments_card' } }),
        {},
        { pool },
    );
    const body = parseBody(r);
    assert.equal(body.widget_config.publicId, TEST_PUBLIC_ID);

    restoreEnv();
    resetTestAuthSecrets();
});

test('E3: invoiceId = subscription_id (UUID); accountId = user_id', async () => {
    setTestAuthSecrets();
    setPublicId(TEST_PUBLIC_ID);
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ jwt, body: { tariff: 'monthly_499', provider: 'cloudpayments_sbp' } }),
        {},
        { pool },
    );
    const body = parseBody(r);
    // subscription_id из ответа должен совпадать с widget_config.invoiceId
    assert.equal(body.widget_config.invoiceId, body.subscription_id);
    assert.equal(body.widget_config.accountId, user_id);
    // UUID-формат
    assert.match(body.widget_config.invoiceId, /^[0-9a-f-]{36}$/i);

    restoreEnv();
    resetTestAuthSecrets();
});

test('E4: amount = 499 (рубли), не 49900 (копейки)', async () => {
    setTestAuthSecrets();
    setPublicId(TEST_PUBLIC_ID);
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(
        makeEvent({ jwt, body: { tariff: 'monthly_499', provider: 'cloudpayments_card' } }),
        {},
        { pool },
    );
    const body = parseBody(r);
    assert.equal(body.widget_config.amount, 499,
                 'CloudPayments Widget ожидает amount в рублях, не копейках');
    assert.ok(body.widget_config.description.includes('499'),
              'description должен содержать сумму тарифа');

    restoreEnv();
    resetTestAuthSecrets();
});

test('E5: STUB_TODO_STAGE_7 больше НЕ в ответе + без env → 500', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    // Часть 1: с env — проверяем что STUB_TODO_STAGE_7 не появляется
    setPublicId(TEST_PUBLIC_ID);
    const r1 = await handler(
        makeEvent({ jwt, body: { tariff: 'monthly_499', provider: 'cloudpayments_card' } }),
        {},
        { pool },
    );
    assert.equal(r1.statusCode, 200);
    const body1 = parseBody(r1);
    assert.ok(!('payment_url' in body1),
              'payment_url не должен быть в ответе после замены STUB');
    assert.ok(!JSON.stringify(body1).includes('STUB_TODO_STAGE_7'),
              'STUB_TODO_STAGE_7 не должен встречаться нигде в response');
    assert.notEqual(body1.next_step, 'redirect_to_cloudpayments',
                    'next_step должен быть open_cloudpayments_widget, не redirect');

    // Часть 2: без env → 500 (fail-loud)
    setPublicId(null);
    const { user_id: u2 } = await createTestUser(pool, '+79267777777');
    const { jwt: jwt2 } = await createTestSession(pool, u2);
    const r2 = await handler(
        makeEvent({ jwt: jwt2, body: { tariff: 'monthly_499', provider: 'cloudpayments_card' } }),
        {},
        { pool },
    );
    assert.equal(r2.statusCode, 500,
                 'без CLOUDPAYMENTS_PUBLIC_ID должен быть 500, не silent broken widget');

    restoreEnv();
    resetTestAuthSecrets();
});
