// =============================================================================
// coupons-reveal.test.js — POST /api/coupons/{id}/reveal (6.7).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/coupons/reveal.js';
import { handler as copyHandler } from '../handlers/coupons/copy.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestSubscription,
    createTestMerchant,
    createTestCoupon,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ jwt = null, couponId = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        pathParameters: couponId == null ? null : { id: String(couponId) },
        body: '',
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

async function makeCoupon(pool, opts = {}) {
    const merchant = await createTestMerchant(pool);
    return createTestCoupon(pool, { merchant_id: merchant.id, ...opts });
}

// =============================================================================
// E — /coupons/{id}/reveal
// =============================================================================

test('19: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCoupon(pool);
    const r = await handler(makeEvent({ couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('20: без активной подписки → 403 subscription_required + redirect_to', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    const r = await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 403);
    const body = parseBody(r);
    assert.equal(body.error, 'subscription_required');
    assert.ok(body.message);
    assert.equal(body.redirect_to, '/subscribe');
    resetTestAuthSecrets();
});

test('21: cancelled подписка + expires_at в БУДУЩЕМ → 200 (доступ доигрывает)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id, { status: 'cancelled' });
    const coupon = await makeCoupon(pool);

    const r = await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).code, coupon.code);
    resetTestAuthSecrets();
});

test('22: cancelled + expires_at в ПРОШЛОМ → 403', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // Создаём cancelled с expires_at в прошлом — direct INSERT
    await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, cancelled_at, expires_at)
         VALUES ($1, 'daily_35', 'operator_mock', 'cancelled', 3500,
                 now() - interval '2 days', now() - interval '1 hour',
                 now() - interval '1 hour')`,
        [user_id],
    );
    const coupon = await makeCoupon(pool);

    const r = await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 403);
    resetTestAuthSecrets();
});

test('23: coupon не существует → 404', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id);

    const r = await handler(makeEvent({ jwt, couponId: 9999 }), {}, { pool });
    assert.equal(r.statusCode, 404);
    assert.equal(parseBody(r).error, 'coupon_not_found');
    resetTestAuthSecrets();
});

test('24: coupon.status="expired" → 410 coupon_not_active', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id);
    const coupon = await makeCoupon(pool, { status: 'expired' });

    const r = await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 410);
    const body = parseBody(r);
    assert.equal(body.error, 'coupon_not_active');
    assert.equal(body.status, 'expired');
    resetTestAuthSecrets();
});

test('25: повторный reveal того же coupon (idempotent) → 200, без второй записи', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id);
    const coupon = await makeCoupon(pool);

    await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });

    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.coupon_reveals WHERE user_id = $1`,
        [user_id])).rows[0].c;
    assert.equal(c, 1);
    resetTestAuthSecrets();
});

test('26: после reveal запись в coupon_reveals создана', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id);
    const coupon = await makeCoupon(pool);

    await handler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    const rows = (await pool.query(
        `SELECT coupon_id FROM private_data.coupon_reveals WHERE user_id = $1`,
        [user_id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].coupon_id), coupon.id);
    resetTestAuthSecrets();
});

// invalid_coupon_id
test('invalid coupon_id (не число) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestSubscription(pool, user_id);

    const event = {
        httpMethod: 'POST',
        headers: { origin: 'https://gde-code.ru', authorization: `Bearer ${jwt}` },
        pathParameters: { id: 'abc' },
        body: '',
    };
    const r = await handler(event, {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_coupon_id');
    resetTestAuthSecrets();
});

// =============================================================================
// F — /coupons/{id}/copy
// =============================================================================

test('27: copy без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCoupon(pool);
    const r = await copyHandler(makeEvent({ couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('28: copy с JWT → 200 { ok: true }', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);
    const r = await copyHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { ok: true });
    resetTestAuthSecrets();
});

test('29: copy НЕ требует подписки', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);  // нет подписки
    const coupon = await makeCoupon(pool);
    const r = await copyHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    resetTestAuthSecrets();
});

test('copy без coupon_id → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await copyHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

// HTTP
test('OPTIONS reveal → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET reveal → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
