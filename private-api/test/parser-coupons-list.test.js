// =============================================================================
// parser-coupons-list.test.js — GET /api/admin/parser/coupons (Group B).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/admin/parser/coupons-list.js';
import {
    newPgMemPool,
    createTestMerchant,
    createTestCoupon,
} from './helpers.js';

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

/**
 * Создаёт coupon с явным tier и/или last_checked_at.
 * last_checked_at: null (default) | Date | offset секунд назад
 */
async function insertCoupon(pool, { tier = 3, last_checked_at = null,
                                     status = 'active', confirmed_count = 0, code = 'TEST' } = {}) {
    // Уникальный domain на каждый INSERT (default createTestMerchant
    // генерирует random UUID-domain) — иначе pg-mem path planner
    // некорректно работает с filter'ами при нескольких записях.
    const merchant = await createTestMerchant(pool);
    // ★ pg-mem некорректно сравнивает Date object / now()-interval-результат
    //   с string-параметром в WHERE. Пишем как ISO-строку — она работает в
    //   обоих направлениях (INSERT и WHERE filter).
    const lastCheckIso = last_checked_at instanceof Date
        ? last_checked_at.toISOString()
        : last_checked_at != null
            ? new Date(Date.now() - last_checked_at * 1000).toISOString()
            : null;
    const { rows } = await pool.query(
        `INSERT INTO public_data.coupons
           (merchant_id, description, discount, code, status,
            tier, last_checked_at, confirmed_count, complaint_count)
         VALUES ($1, 'd', '-10', $2, $3, $4, $5, $6, 0)
         RETURNING id`,
        [merchant.id, code, status, tier, lastCheckIso, confirmed_count],
    );
    return rows[0].id;
}

// =============================================================================
// B7-B14
// =============================================================================

test('B7: без X-Parser-Secret → 401', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ secret: null, query: { tier: '1' } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_parser_secret');
    resetSecret();
});

test('B8: tier=invalid → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ query: { tier: 'abc' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_tier');
    resetSecret();
});

test('B8b: tier=5 (не в наборе) → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ query: { tier: '5' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_tier');
    resetSecret();
});

test('B9: tier=1, нет старых → items=[]', async () => {
    setSecret();
    const pool = await newPgMemPool();
    // Coupon tier=1 но только что проверен — не попадает
    await insertCoupon(pool, { tier: 1, last_checked_at: 60 });

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.items.length, 0);
    assert.equal(body.total, 0);
    resetSecret();
});

test('B10: tier=1, coupon 4ч назад (старше интервала 3ч) → попадает', async () => {
    // ⚠️ pg-mem quirk: при 3+ coupons с разными last_checked_at в одной
    // таблице фильтр `WHERE last_checked_at < cutoff` возвращает неполные
    // результаты (см. REAL_PG_CHECKLIST.md). На реальном PG этого нет.
    // Здесь проверяем 1 coupon — этого достаточно для проверки логики;
    // B11 покрывает обратный кейс «свежий не попадает».
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { tier: 1, last_checked_at: 4 * 3600, code: 'OLD' });

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].code, 'OLD');
    resetSecret();
});

test('B10b: tier=1, last_checked_at=NULL (никогда не проверялся) → попадает', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { tier: 1, last_checked_at: null, code: 'NEVER' });

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].code, 'NEVER');
    resetSecret();
});

test('B11: tier=2, интервал 8ч → coupon 7ч назад НЕ возвращается, 9ч — да', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { tier: 2, last_checked_at: 7 * 3600 });
    await insertCoupon(pool, { tier: 2, last_checked_at: 9 * 3600 });

    const r = await handler(makeEvent({ query: { tier: '2' } }), {}, { pool });
    assert.equal(parseBody(r).items.length, 1);
    resetSecret();
});

test('B12: только status="active" возвращаются', async () => {
    setSecret();
    const pool = await newPgMemPool();
    await insertCoupon(pool, { tier: 1, status: 'active',  last_checked_at: 4 * 3600 });
    await insertCoupon(pool, { tier: 1, status: 'expired', last_checked_at: 4 * 3600 });

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    assert.equal(parseBody(r).items.length, 1);
    resetSecret();
});

test('B13: NULL last_checked_at сортируется первым', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const oldId  = await insertCoupon(pool, { tier: 1, last_checked_at: 10 * 3600, code: 'OLD' });
    const neverId = await insertCoupon(pool, { tier: 1, last_checked_at: null, code: 'NEVER' });

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    const items = parseBody(r).items;
    assert.equal(items[0].id, neverId, 'never-checked должен быть первым');
    resetSecret();
});

test('B14: limit/offset работают', async () => {
    setSecret();
    const pool = await newPgMemPool();
    for (let i = 0; i < 5; i++) {
        await insertCoupon(pool, { tier: 3, last_checked_at: 25 * 3600 + i * 60, code: `C${i}` });
    }
    const r1 = await handler(makeEvent({ query: { tier: '3', limit: '2' } }), {}, { pool });
    assert.equal(parseBody(r1).items.length, 2);
    assert.equal(parseBody(r1).total, 5);

    const r2 = await handler(makeEvent({ query: { tier: '3', limit: '2', offset: '2' } }), {}, { pool });
    assert.equal(parseBody(r2).items.length, 2);
    resetSecret();
});

test('limit > MAX_LIMIT (200) → 400', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ query: { tier: '1', limit: '201' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_limit');
    resetSecret();
});

test('merchant: slug = split_part(domain, ".", 1)', async () => {
    setSecret();
    const pool = await newPgMemPool();
    const m = await createTestMerchant(pool, { domain: 'wildberries.ru', name: 'WB' });
    await pool.query(
        `INSERT INTO public_data.coupons (merchant_id, description, discount, code, status, tier)
         VALUES ($1, 'd', '-10', 'TEST', 'active', 1)`, [m.id]);

    const r = await handler(makeEvent({ query: { tier: '1' } }), {}, { pool });
    const merchant = parseBody(r).items[0].merchant;
    assert.equal(merchant.slug, 'wildberries');
    assert.equal(merchant.domain, 'wildberries.ru');
    assert.equal(merchant.name, 'WB');
    resetSecret();
});

// HTTP
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
