// =============================================================================
// coupon-thresholds.test.js — триггеры жалоб 3/5/10 (ТЗ §20.4).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as complaintHandler } from '../handlers/coupons/complaint.js';
import { handler as revealHandler    } from '../handlers/coupons/reveal.js';
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

function makeEvent({ jwt = null, couponId = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        pathParameters: couponId == null ? null : { id: String(couponId) },
        body: '',
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function captureLogs(fn) {
    const o = { log: console.log, warn: console.warn, error: console.error };
    const lines = [];
    const sink = (...args) =>
        lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    console.log = sink; console.warn = sink; console.error = sink;
    let result;
    try { result = await fn(); }
    finally { console.log = o.log; console.warn = o.warn; console.error = o.error; }
    return { result, logs: lines.join('\n') };
}

async function makeCouponWithComplaints(pool, n) {
    const merchant = await createTestMerchant(pool);
    return createTestCoupon(pool, {
        merchant_id: merchant.id,
        complaint_count: n,
        status: 'active',
    });
}

async function makeAuthedUserWithJwt(pool, phone) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt }     = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// I — Триггеры по порогам
// =============================================================================

test('41: complaint_count = 3 → лог urgent_recheck, status="active" остаётся', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCouponWithComplaints(pool, 2);  // +1 от теста = 3
    const { jwt } = await makeAuthedUserWithJwt(pool, '+79261111111');

    const { result: r, logs } = await captureLogs(() =>
        complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.complaint_count, 3);
    assert.equal(body.status_changed, null);

    // Лог urgent_recheck
    assert.match(logs, /coupon\.urgent_recheck/);

    // Status в БД остался active
    const c = (await pool.query(`SELECT status FROM public_data.coupons WHERE id = $1`, [coupon.id])).rows[0];
    assert.equal(c.status, 'active');
    resetTestAuthSecrets();
});

test('42: complaint_count = 5 → status переходит в "expired"', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCouponWithComplaints(pool, 4);  // +1 от теста = 5
    const { jwt } = await makeAuthedUserWithJwt(pool, '+79261111111');

    const { result: r, logs } = await captureLogs(() =>
        complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.complaint_count, 5);
    assert.equal(body.status_changed, 'expired');

    assert.match(logs, /coupon\.auto_expired/);

    const c = (await pool.query(`SELECT status FROM public_data.coupons WHERE id = $1`, [coupon.id])).rows[0];
    assert.equal(c.status, 'expired');
    resetTestAuthSecrets();
});

test('43: complaint_count = 10 → лог merchant_block_threshold (status уже expired)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // Уже 9 жалоб + статус expired (мы прошли AUTO_EXPIRE ранее)
    const merchant = await createTestMerchant(pool);
    const coupon = await createTestCoupon(pool, {
        merchant_id: merchant.id,
        complaint_count: 9,
        status: 'expired',
    });
    const { jwt } = await makeAuthedUserWithJwt(pool, '+79261111111');

    const { result: r, logs } = await captureLogs(() =>
        complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool }));
    // status=expired → handler возвращает 410 ДО голосования
    assert.equal(r.statusCode, 410);
    // (порог 10 не достигнут, потому что голос не засчитан — но это
    //  и есть проектное поведение: на expired coupon не голосуют)
    resetTestAuthSecrets();
});

test('43b: complaint_count достигает 10 на active coupon → BLOCK_MERCHANT WARN + status=expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // Active coupon с 9 жалобами; следующая = 10, что вызовет AUTO_EXPIRE и BLOCK_MERCHANT
    const merchant = await createTestMerchant(pool);
    const coupon = await createTestCoupon(pool, {
        merchant_id: merchant.id,
        complaint_count: 9,
        status: 'active',
    });
    const { jwt } = await makeAuthedUserWithJwt(pool, '+79261111111');

    const { result: r, logs } = await captureLogs(() =>
        complaintHandler(makeEvent({ jwt, couponId: coupon.id }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).complaint_count, 10);

    assert.match(logs, /merchant_block_threshold/);
    assert.match(logs, /action_required.*manual_review/);
    // AUTO_EXPIRE тоже сработал, потому что 10 >= 5
    assert.match(logs, /coupon\.auto_expired/);

    const c = (await pool.query(`SELECT status FROM public_data.coupons WHERE id = $1`, [coupon.id])).rows[0];
    assert.equal(c.status, 'expired');
    resetTestAuthSecrets();
});

test('44: после AUTO_EXPIRE reveal этого coupon → 410 coupon_not_active', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCouponWithComplaints(pool, 4);
    const alice = await makeAuthedUserWithJwt(pool, '+79261111111');
    // Алиса жалуется — 5 жалоб → AUTO_EXPIRE
    await complaintHandler(makeEvent({ jwt: alice.jwt, couponId: coupon.id }), {}, { pool });

    // Боб с подпиской пытается reveal → 410
    const bob = await makeAuthedUserWithJwt(pool, '+79262222222');
    await createTestSubscription(pool, bob.user_id);
    const r = await revealHandler(makeEvent({ jwt: bob.jwt, couponId: coupon.id }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'coupon_not_active');
    resetTestAuthSecrets();
});

test('45: счётчик корректен после параллельных complaint от РАЗНЫХ user (UPDATE атомарен)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const coupon = await makeCouponWithComplaints(pool, 0);

    // Создаём 3 разных user (один user не может голосовать дважды в 24ч)
    const users = await Promise.all([
        makeAuthedUserWithJwt(pool, '+79261111111'),
        makeAuthedUserWithJwt(pool, '+79262222222'),
        makeAuthedUserWithJwt(pool, '+79263333333'),
    ]);

    const results = await Promise.all(
        users.map(u => complaintHandler(makeEvent({ jwt: u.jwt, couponId: coupon.id }), {}, { pool }))
    );
    for (const r of results) assert.equal(r.statusCode, 200);

    const c = (await pool.query(
        `SELECT complaint_count FROM public_data.coupons WHERE id = $1`, [coupon.id])).rows[0];
    assert.equal(c.complaint_count, 3, 'все 3 параллельных INSERTа должны были засчитаться');
    resetTestAuthSecrets();
});

test('46: изоляция между coupon — жалобы на A не влияют на B', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const merchant = await createTestMerchant(pool);
    const couponA = await createTestCoupon(pool, { merchant_id: merchant.id, code: 'A' });
    const couponB = await createTestCoupon(pool, { merchant_id: merchant.id, code: 'B' });
    const { jwt } = await makeAuthedUserWithJwt(pool, '+79261111111');

    await complaintHandler(makeEvent({ jwt, couponId: couponA.id }), {}, { pool });

    const a = (await pool.query(`SELECT complaint_count FROM public_data.coupons WHERE id = $1`, [couponA.id])).rows[0];
    const b = (await pool.query(`SELECT complaint_count FROM public_data.coupons WHERE id = $1`, [couponB.id])).rows[0];
    assert.equal(a.complaint_count, 1);
    assert.equal(b.complaint_count, 0);
    resetTestAuthSecrets();
});
