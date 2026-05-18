// =============================================================================
// parser-coupon-detail.test.js — GET /api/admin/parser/coupon/{id} (Group D).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/admin/parser/coupon-detail.js';
import { newPgMemPool, createTestMerchant, createTestCoupon } from './helpers.js';

const PARSER_SECRET = 'parser-secret-32-bytes-XXXXXXXXX';
const savedSecret = process.env.PARSER_SECRET;
function setSecret() { process.env.PARSER_SECRET = PARSER_SECRET; }
function resetSecret() {
    if (savedSecret === undefined) delete process.env.PARSER_SECRET;
    else                            process.env.PARSER_SECRET = savedSecret;
}

function makeEvent({ secret = PARSER_SECRET, couponId = null, method = 'GET',
                     origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(secret ? { 'x-parser-secret': secret } : {}) },
        pathParameters: couponId == null ? null : { id: String(couponId) },
    };
}
function parseBody(res) { return JSON.parse(res.body); }

// =============================================================================
// D20-D23
// =============================================================================

test('20: без секрета → 401', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const m = await createTestMerchant(pool);
    const c = await createTestCoupon(pool, { merchant_id: m.id });
    const r = await handler(makeEvent({ secret: null, couponId: c.id }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetSecret();
});

test('21: несуществующий id → 404', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ couponId: 9999 }), {}, { pool });
    assert.equal(r.statusCode, 404);
    assert.equal(parseBody(r).error, 'coupon_not_found');
    resetSecret();
});

test('22: invalid id → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const event = {
        httpMethod: 'GET',
        headers: { origin: 'https://gde-code.ru', 'x-parser-secret': PARSER_SECRET },
        pathParameters: { id: 'abc' },
    };
    const r = await handler(event, {}, { pool });
    assert.equal(r.statusCode, 400);
    resetSecret();
});

test('23: существующий → все поля + merchant с slug', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const m = await createTestMerchant(pool, { domain: 'wb.ru', name: 'WB' });
    const c = await createTestCoupon(pool, { merchant_id: m.id, description: 'desc', discount: '-50', code: 'WB50' });

    const r = await handler(makeEvent({ couponId: c.id }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const coupon = parseBody(r).coupon;
    assert.equal(coupon.id, c.id);
    assert.equal(coupon.description, 'desc');
    assert.equal(coupon.discount, '-50');
    assert.equal(coupon.code, 'WB50');
    assert.equal(coupon.tier, 3);
    assert.equal(coupon.status, 'active');
    assert.ok(coupon.votes);
    assert.equal(coupon.votes.confirmed, 0);
    assert.equal(coupon.votes.complaint, 0);
    assert.equal(coupon.merchant.name, 'WB');
    assert.equal(coupon.merchant.slug, 'wb');
    assert.equal(coupon.merchant.domain, 'wb.ru');
    resetSecret();
});

test('OPTIONS → 204', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetSecret();
});

test('POST → 405', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'POST' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetSecret();
});
