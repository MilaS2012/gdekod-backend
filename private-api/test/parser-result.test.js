// =============================================================================
// parser-result.test.js — POST /api/admin/parser/result (Group E).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/admin/parser/result.js';
import { newPgMemPool, createTestMerchant, createTestCoupon } from './helpers.js';

const PARSER_SECRET = 'parser-secret-32-bytes-XXXXXXXXX';
const savedSecret = process.env.PARSER_SECRET;
function setSecret() { process.env.PARSER_SECRET = PARSER_SECRET; }
function resetSecret() {
    if (savedSecret === undefined) delete process.env.PARSER_SECRET;
    else                            process.env.PARSER_SECRET = savedSecret;
}

function makeEvent({ secret = PARSER_SECRET, body = null, method = 'POST',
                     origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(secret ? { 'x-parser-secret': secret } : {}) },
        body: body == null ? '' : JSON.stringify(body),
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

async function makeCoupon(pool, opts = {}) {
    const m = await createTestMerchant(pool);
    return createTestCoupon(pool, { merchant_id: m.id, ...opts });
}

// =============================================================================
// E24-E35
// =============================================================================

test('24: без секрета → 401', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ secret: null, body: { coupon_id: 1, status: 'active' } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetSecret();
});

test('25: невалидный coupon_id → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: { coupon_id: 0, status: 'active' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_coupon_id');
    resetSecret();
});

test('26: несуществующий coupon → 404', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: { coupon_id: 9999, status: 'active' } }), {}, { pool });
    assert.equal(r.statusCode, 404);
    resetSecret();
});

test('27: invalid status → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);
    const r = await handler(makeEvent({ body: { coupon_id: c.id, status: 'unknown' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_status');
    resetSecret();
});

test('28: status="active" → last_checked_at + last_successful_check_at + last_parse_status', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);

    const r = await handler(makeEvent({ body: { coupon_id: c.id, status: 'active' } }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const after = (await pool.query(
        `SELECT last_checked_at, last_successful_check_at, last_parse_status, last_parse_error
           FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.ok(after.last_checked_at != null);
    assert.ok(after.last_successful_check_at != null);
    assert.equal(after.last_parse_status, 'active');
    assert.equal(after.last_parse_error, null);
    resetSecret();
});

test('29: status="active" + new_code → code обновлён', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool, { code: 'OLD' });

    await handler(makeEvent({ body: { coupon_id: c.id, status: 'active', new_code: 'NEW123' } }), {}, { pool });
    const after = (await pool.query(`SELECT code FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.code, 'NEW123');
    resetSecret();
});

test('30: status="active" без new_code → code остался прежним (COALESCE)', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool, { code: 'KEEPME' });

    await handler(makeEvent({ body: { coupon_id: c.id, status: 'active' } }), {}, { pool });
    const after = (await pool.query(`SELECT code FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.code, 'KEEPME');
    resetSecret();
});

test('31: status="expired" → status в БД = "expired", new_status в ответе', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool, { status: 'active' });

    const r = await handler(makeEvent({ body: { coupon_id: c.id, status: 'expired' } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).new_status, 'expired');

    const after = (await pool.query(`SELECT status FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.status, 'expired');
    resetSecret();
});

test('32: status="expired" дважды подряд → race-safe (не падает, второй UPDATE last_checked_at)', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);

    const r1 = await handler(makeEvent({ body: { coupon_id: c.id, status: 'expired' } }), {}, { pool });
    assert.equal(r1.statusCode, 200);

    const r2 = await handler(makeEvent({ body: { coupon_id: c.id, status: 'expired' } }), {}, { pool });
    assert.equal(r2.statusCode, 200, 'повторный /result expired должен пройти без ошибки');

    // last_checked_at обновлён обоими вызовами
    const after = (await pool.query(`SELECT status, last_checked_at FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.status, 'expired');
    assert.ok(after.last_checked_at != null);
    resetSecret();
});

test('33: status="not_found" → status="expired" + WARN-лог', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);

    const { result: r, logs } = await captureLogs(() =>
        handler(makeEvent({ body: { coupon_id: c.id, status: 'not_found' } }), {}, { pool }));
    assert.equal(r.statusCode, 200);

    const after = (await pool.query(`SELECT status, last_parse_status FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.status, 'expired');
    assert.equal(after.last_parse_status, 'not_found');
    assert.match(logs, /parser\.not_found/);
    resetSecret();
});

test('34: status="parsing_error" → status НЕ меняется, last_parse_error записан', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);

    const { result: r, logs } = await captureLogs(() =>
        handler(makeEvent({
            body: { coupon_id: c.id, status: 'parsing_error',
                    error_text: 'Selector .promo-button not found' }
        }), {}, { pool }));
    assert.equal(r.statusCode, 200);

    const after = (await pool.query(
        `SELECT status, last_parse_status, last_parse_error FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.status, 'active');  // ★ НЕ меняется
    assert.equal(after.last_parse_status, 'parsing_error');
    assert.match(after.last_parse_error, /Selector/);
    assert.match(logs, /parser\.parsing_error/);
    resetSecret();
});

test('35: длинный error_text → truncate до 1000 + WARN field_truncated', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);
    const long = 'X'.repeat(1500);

    const { result: r, logs } = await captureLogs(() =>
        handler(makeEvent({
            body: { coupon_id: c.id, status: 'parsing_error', error_text: long }
        }), {}, { pool }));
    assert.equal(r.statusCode, 200);

    const after = (await pool.query(`SELECT last_parse_error FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.last_parse_error.length, 1000);
    assert.match(logs, /parser\.field_truncated/);
    assert.match(logs, /"field":"error_text"/);
    assert.match(logs, /"original_length":1500/);
    resetSecret();
});

test('длинный new_code → truncate до 128 + WARN', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const c = await makeCoupon(pool);
    const longCode = 'C'.repeat(200);

    const { logs } = await captureLogs(() =>
        handler(makeEvent({ body: { coupon_id: c.id, status: 'active', new_code: longCode } }), {}, { pool }));
    const after = (await pool.query(`SELECT code FROM public_data.coupons WHERE id = $1`, [c.id])).rows[0];
    assert.equal(after.code.length, 128);
    assert.match(logs, /parser\.field_truncated.*"field":"code"/);
    resetSecret();
});

// HTTP
test('OPTIONS → 204', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetSecret();
});

test('GET → 405', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetSecret();
});

test('invalid_json body → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(
        { httpMethod: 'POST', headers: { 'x-parser-secret': PARSER_SECRET }, body: '{not_json' },
        {}, { pool });
    assert.equal(r.statusCode, 400);
    resetSecret();
});
