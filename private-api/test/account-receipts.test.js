// =============================================================================
// account-receipts.test.js — GET /api/account/receipts (6.7).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/account/receipts.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestSubscription,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ jwt = null, query = null, method = 'GET', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        queryStringParameters: query,
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

async function insertReceipt(pool, user_id, opts = {}) {
    const {
        amount_kopecks = 3500,
        provider       = 'operator_mock',
        is_mock        = true,
        receipt_url    = null,
        subscription_id = null,
    } = opts;
    await pool.query(
        `INSERT INTO private_data.receipts
           (user_id, subscription_id, amount_kopecks, currency,
            provider, provider_receipt_url, is_mock,
            period_start, period_end)
         VALUES ($1, $2, $3, 'RUB', $4, $5, $6,
                 now() - interval '1 day', now())`,
        [user_id, subscription_id, amount_kopecks, provider, receipt_url, is_mock],
    );
}

// =============================================================================
// D — /account/receipts
// =============================================================================

test('15: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('16: пустые → items=[], total=0', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    resetTestAuthSecrets();
});

test('17: amount_rub = amount_kopecks/100', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await insertReceipt(pool, user_id, { amount_kopecks: 49900 });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const item = parseBody(r).items[0];
    assert.equal(item.amount_kopecks, 49900);
    assert.equal(item.amount_rub, 499);
    resetTestAuthSecrets();
});

test('18: is_mock=true для staging mock-receipt, false для prod', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await insertReceipt(pool, user_id, { is_mock: true });
    await insertReceipt(pool, user_id, { is_mock: false, provider: 'cloudpayments_card',
                                          receipt_url: 'https://ofd.example/receipt/123' });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const items = parseBody(r).items;
    assert.equal(items.length, 2);
    const mockItem = items.find(i => i.is_mock === true);
    const realItem = items.find(i => i.is_mock === false);
    assert.ok(mockItem, 'mock receipt должен быть в списке');
    assert.ok(realItem, 'real receipt должен быть в списке');
    assert.equal(realItem.receipt_url, 'https://ofd.example/receipt/123');
    assert.equal(mockItem.receipt_url, null);
    resetTestAuthSecrets();
});

test('изоляция: чеки другого user не видны', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const alice = await authedSetup(pool, '+79261111111');
    const { user_id: bobId } = await createTestUser(pool, '+79262222222');
    await insertReceipt(pool, bobId);

    const r = await handler(makeEvent({ jwt: alice.jwt }), {}, { pool });
    assert.equal(parseBody(r).total, 0);
    resetTestAuthSecrets();
});

test('invalid_pagination: limit=51 → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, query: { limit: '51' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
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
