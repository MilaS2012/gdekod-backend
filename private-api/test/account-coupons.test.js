// =============================================================================
// account-coupons.test.js — GET /api/account/coupons (6.7).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/account/coupons.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestMerchant,
    createTestCoupon,
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

async function revealCoupon(pool, user_id, coupon_id) {
    await pool.query(
        `INSERT INTO private_data.coupon_reveals (user_id, coupon_id) VALUES ($1, $2)`,
        [user_id, coupon_id],
    );
}

// =============================================================================
// C — /account/coupons
// =============================================================================

test('10: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('11: пустая история → items=[], total=0', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    resetTestAuthSecrets();
});

test('12: с 3 раскрытыми → items=3, отсортированы по дате DESC', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const merchant = await createTestMerchant(pool, { name: 'WB', domain: 'wb.ru' });
    const c1 = await createTestCoupon(pool, { merchant_id: merchant.id, code: 'CODE-1' });
    const c2 = await createTestCoupon(pool, { merchant_id: merchant.id, code: 'CODE-2' });
    const c3 = await createTestCoupon(pool, { merchant_id: merchant.id, code: 'CODE-3' });

    // Раскрываем в порядке c1, c2, c3 — последний должен быть первым в выдаче
    await revealCoupon(pool, user_id, c1.id);
    await new Promise(r => setTimeout(r, 5));
    await revealCoupon(pool, user_id, c2.id);
    await new Promise(r => setTimeout(r, 5));
    await revealCoupon(pool, user_id, c3.id);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.items.length, 3);
    assert.equal(body.total, 3);
    assert.equal(body.items[0].coupon.code, 'CODE-3');
    assert.equal(body.items[1].coupon.code, 'CODE-2');
    assert.equal(body.items[2].coupon.code, 'CODE-1');
    // merchant поля
    assert.equal(body.items[0].coupon.merchant.name, 'WB');
    assert.equal(body.items[0].coupon.merchant.slug, 'wb');
    resetTestAuthSecrets();
});

test('13: удалённый coupon → placeholder с status="removed"', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const merchant = await createTestMerchant(pool);
    const coupon = await createTestCoupon(pool, { merchant_id: merchant.id });
    await revealCoupon(pool, user_id, coupon.id);
    // Удаляем coupon
    await pool.query(`DELETE FROM public_data.coupons WHERE id = $1`, [coupon.id]);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].coupon.status, 'removed');
    assert.ok(body.items[0].coupon.message);
    resetTestAuthSecrets();
});

test('14: limit=50 max, limit=51 → 400 invalid_pagination', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r1 = await handler(makeEvent({ jwt, query: { limit: '50' } }), {}, { pool });
    assert.equal(r1.statusCode, 200);

    const r2 = await handler(makeEvent({ jwt, query: { limit: '51' } }), {}, { pool });
    assert.equal(r2.statusCode, 400);
    assert.equal(parseBody(r2).error, 'invalid_pagination');
    resetTestAuthSecrets();
});

test('изоляция: история другого user не видна', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const merchant = await createTestMerchant(pool);
    const coupon = await createTestCoupon(pool, { merchant_id: merchant.id });

    const alice = await authedSetup(pool, '+79261111111');
    const { user_id: bobId } = await createTestUser(pool, '+79262222222');
    await revealCoupon(pool, bobId, coupon.id);

    const r = await handler(makeEvent({ jwt: alice.jwt }), {}, { pool });
    assert.equal(parseBody(r).total, 0);
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
