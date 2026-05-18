// =============================================================================
// coupons-vote.test.js — confirm + complaint (без триггеров — см. thresholds).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as confirmHandler   } from '../handlers/coupons/confirm.js';
import { handler as complaintHandler } from '../handlers/coupons/complaint.js';
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

function makeEvent({ jwt = null, couponId = null, body = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        pathParameters: couponId == null ? null : { id: String(couponId) },
        body: body == null ? '' : JSON.stringify(body),
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

// Подделываем "старое" голосование с created_at в прошлом, чтобы обойти cooldown.
async function insertOldVote(pool, user_id, coupon_id, vote_type, hoursAgo) {
    const createdAt = new Date(Date.now() - hoursAgo * 3600 * 1000);
    await pool.query(
        `INSERT INTO private_data.coupon_votes (user_id, coupon_id, vote_type, created_at)
         VALUES ($1, $2, $3, $4)`,
        [user_id, coupon_id, vote_type, createdAt],
    );
}

// =============================================================================
// G — /coupons/{id}/confirm
// =============================================================================

test('30: confirm без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCoupon(pool);
    const r = await confirmHandler(makeEvent({ couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('31: confirm coupon не существует → 404', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await confirmHandler(makeEvent({ jwt, couponId: 9999 }), {}, { pool });
    assert.equal(r.statusCode, 404);
    resetTestAuthSecrets();
});

test('32: confirm на expired coupon → 410', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool, { status: 'expired' });
    const r = await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'coupon_not_active');
    resetTestAuthSecrets();
});

test('33: первый confirm → 200, INSERT vote, confirmed_count+1', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    const r = await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.confirmed_count, 1);
    assert.equal(body.your_vote, 'confirm');

    const votes = (await pool.query(
        `SELECT vote_type FROM private_data.coupon_votes WHERE user_id = $1`,
        [user_id])).rows;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].vote_type, 'confirm');
    resetTestAuthSecrets();
});

test('34: второй confirm в 24ч → 429 too_many_votes', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    const r2 = await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r2.statusCode, 429);
    const body = parseBody(r2);
    assert.equal(body.error, 'too_many_votes');
    assert.equal(body.previous_vote, 'confirm');
    assert.ok(body.next_vote_allowed_at);
    resetTestAuthSecrets();
});

test('35: через 24+ часов → можно проголосовать снова', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    // Старый голос 25 часов назад
    await insertOldVote(pool, user_id, coupon.id, 'confirm', 25);

    const r = await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).confirmed_count, 1);
    resetTestAuthSecrets();
});

// =============================================================================
// H — /coupons/{id}/complaint
// =============================================================================

test('36: complaint без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCoupon(pool);
    const r = await complaintHandler(makeEvent({ couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('37: первая complaint → 200, INSERT vote, complaint_count+1', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    const r = await complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.complaint_count, 1);
    assert.equal(body.your_vote, 'complaint');
    assert.equal(body.status_changed, null);
    resetTestAuthSecrets();
});

test('38: last_complaint_at заполнен после жалобы', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    await complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    const c = (await pool.query(
        `SELECT last_complaint_at FROM public_data.coupons WHERE id = $1`, [coupon.id])).rows[0];
    assert.ok(c.last_complaint_at != null);
    resetTestAuthSecrets();
});

test('39: второй голос (любой) в 24ч → 429', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    await complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    const r = await complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 429);
    resetTestAuthSecrets();
});

test('40: confirm + complaint от одного user на один coupon в 24ч → второй блокируется', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);

    await confirmHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    // Попытка complaint — должна быть отбита cooldown'ом
    const r = await complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).previous_vote, 'confirm');
    resetTestAuthSecrets();
});

test('complaint с body { reason }: принимается без 400, лог получает флаг', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const coupon = await makeCoupon(pool);
    const r = await complaintHandler(
        makeEvent({ jwt, couponId: coupon.id, body: { reason: 'не работает на корзине' } }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    resetTestAuthSecrets();
});

// HTTP
test('OPTIONS confirm → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await confirmHandler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET confirm → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await confirmHandler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('OPTIONS complaint → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await complaintHandler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});
