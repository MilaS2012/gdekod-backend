// =============================================================================
// parser-urgent-queue.test.js — GET /api/admin/parser/urgent-queue (Group C).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/admin/parser/urgent-queue.js';
import { newPgMemPool, createTestMerchant } from './helpers.js';

const PARSER_SECRET = 'parser-secret-32-bytes-XXXXXXXXX';
const savedSecret = process.env.PARSER_SECRET;
function setSecret() { process.env.PARSER_SECRET = PARSER_SECRET; }
function resetSecret() {
    if (savedSecret === undefined) delete process.env.PARSER_SECRET;
    else                            process.env.PARSER_SECRET = savedSecret;
}

function makeEvent({ secret = PARSER_SECRET, query = null, method = 'GET',
                     origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, ...(secret ? { 'x-parser-secret': secret } : {}) },
        queryStringParameters: query,
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function insertCoupon(pool, { complaint_count = 0, status = 'active',
                                     last_checked_at_minutes_ago = null,
                                     last_complaint_at = null } = {}) {
    const merchant = await createTestMerchant(pool);
    // ★ ISO-string для timestamp-полей — pg-mem некорректно сравнивает
    //   Date object / now()-interval с string-параметром в WHERE.
    const lastCheckIso = last_checked_at_minutes_ago != null
        ? new Date(Date.now() - last_checked_at_minutes_ago * 60 * 1000).toISOString()
        : null;
    const lastComplaintIso = last_complaint_at instanceof Date
        ? last_complaint_at.toISOString()
        : last_complaint_at;
    const { rows } = await pool.query(
        `INSERT INTO public_data.coupons
           (merchant_id, description, discount, code, status,
            tier, complaint_count, last_checked_at, last_complaint_at)
         VALUES ($1, 'd', '-10', 'C', $2, 3, $3, $4, $5)
         RETURNING id`,
        [merchant.id, status, complaint_count, lastCheckIso, lastComplaintIso],
    );
    return rows[0].id;
}

// =============================================================================
// C15-C19
// =============================================================================

test('15: без X-Parser-Secret → 401', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ secret: null }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetSecret();
});

test('16: без жалоб (complaint_count=0/1/2) → пусто', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { complaint_count: 0 });
    await insertCoupon(pool, { complaint_count: 1 });
    await insertCoupon(pool, { complaint_count: 2 });

    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).items.length, 0);
    resetSecret();
});

test('17: complaint_count=3,4 в active → попадают', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { complaint_count: 3 });
    await insertCoupon(pool, { complaint_count: 4 });

    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(parseBody(r).items.length, 2);
    resetSecret();
});

test('18: complaint_count >= 5 но уже expired → НЕ попадают', async () => {
    setSecret();
    const pool = await newPgMemPool();
    // status='expired' (auto-expire от жалоб в 6.7)
    await insertCoupon(pool, { complaint_count: 5, status: 'expired' });

    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(parseBody(r).items.length, 0);
    resetSecret();
});

test('19: last_checked_at недавно (< 30 мин) → НЕ попадают', async () => {
    setSecret();
    const pool = await newPgMemPool();
    // 3 жалобы, но проверен 10 минут назад
    await insertCoupon(pool, { complaint_count: 3, last_checked_at_minutes_ago: 10 });
    // 3 жалобы, проверен 40 минут назад
    await insertCoupon(pool, { complaint_count: 3, last_checked_at_minutes_ago: 40 });

    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(parseBody(r).items.length, 1);
    resetSecret();
});

test('ответ содержит recheck_interval_minutes', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(parseBody(r).recheck_interval_minutes, 30);
    resetSecret();
});

test('сортировка по complaint_count DESC', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { complaint_count: 3 });
    await insertCoupon(pool, { complaint_count: 4 });

    const r = await handler(makeEvent({}), {}, { pool });
    const items = parseBody(r).items;
    assert.equal(items[0].votes.complaint, 4);
    assert.equal(items[1].votes.complaint, 3);
    resetSecret();
});

test('limit > MAX (100) → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ query: { limit: '101' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetSecret();
});

test('OPTIONS → 204', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetSecret();
});
