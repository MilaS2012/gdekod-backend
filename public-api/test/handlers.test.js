// =============================================================================
// handlers.test.js — юнит/интеграционные тесты handler'ов с мокнутым PG.
//
// Используем встроенный node:test (Node 20+) — без сторонних фреймворков.
// PG pool подменяем через __setPoolForTest, чтобы handlers не открывали
// реального коннекта.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { __setPoolForTest, __resetPoolForTest } from '../lib/db.js';
import { maskCode } from '../lib/mask-code.js';
import { isAllowedOrigin, corsHeaders } from '../lib/cors.js';

import { handler as listMerchants }  from '../handlers/merchants-list.js';
import { handler as merchantDetail } from '../handlers/merchant-detail.js';
import { handler as listCoupons }    from '../handlers/coupons-list.js';
import { handler as couponDetail }   from '../handlers/coupon-detail.js';
import { handler as healthHandler }  from '../handlers/health.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Строит mock для pg.Pool. Если query совпала с одним из паттернов в
 * `byPattern`, возвращает соответствующий rows. Иначе — пустой массив.
 * Все вызовы пишутся в `calls` для assertion-ов.
 */
function mockPool(byPattern = {}) {
    return {
        calls: [],
        async query(sql, params = []) {
            this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            for (const [pattern, rowsOrFn] of Object.entries(byPattern)) {
                if (sql.includes(pattern)) {
                    const rows = typeof rowsOrFn === 'function'
                        ? rowsOrFn(sql, params)
                        : rowsOrFn;
                    return { rows };
                }
            }
            return { rows: [] };
        },
    };
}

function parseBody(res) { return JSON.parse(res.body); }

function withOrigin(event = {}, origin = 'https://gde-code.ru') {
    return { ...event, headers: { ...(event.headers || {}), origin } };
}

// -----------------------------------------------------------------------------
// lib/mask-code.js
// -----------------------------------------------------------------------------

test('maskCode: преобразует не-дефисы в X, дефисы сохраняет', () => {
    assert.equal(maskCode('WB500RUB'),    'XXXXXXXX');
    assert.equal(maskCode('ABC-1234'),    'XXX-XXXX');
    assert.equal(maskCode('FOO-BAR-BAZ'), 'XXX-XXX-XXX');
});

test('maskCode: пустые/null значения → пустая строка', () => {
    assert.equal(maskCode(''),         '');
    assert.equal(maskCode(null),       '');
    assert.equal(maskCode(undefined),  '');
});

// -----------------------------------------------------------------------------
// lib/cors.js
// -----------------------------------------------------------------------------

test('CORS: gde-code.ru и www — разрешены', () => {
    assert.equal(isAllowedOrigin('https://gde-code.ru'),     true);
    assert.equal(isAllowedOrigin('https://www.gde-code.ru'), true);
});

test('CORS: чужой origin → fallback на gde-code.ru, Vary включает Origin', () => {
    const h = corsHeaders('https://evil.example.com');
    assert.equal(h['Access-Control-Allow-Origin'], 'https://gde-code.ru');
    assert.equal(h['Vary'], 'Origin');
});

// -----------------------------------------------------------------------------
// GET /api/merchants
// -----------------------------------------------------------------------------

test('merchants-list: возвращает массив с приведением coupons_count к числу', async () => {
    __setPoolForTest(mockPool({
        'FROM public_data.merchants m': [
            { id: 1, name: 'Wildberries', slug: 'wildberries', logo_url: null,
              category: 'odezhda',  coupons_count: '4' },
            { id: 2, name: 'Ozon',        slug: 'ozon',        logo_url: 'https://logo',
              category: 'other',    coupons_count: '2' },
        ],
    }));

    const res = await listMerchants(withOrigin({ httpMethod: 'GET' }), {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');

    const body = parseBody(res);
    assert.equal(body.merchants.length, 2);
    assert.deepEqual(body.merchants[0], {
        id: 1, name: 'Wildberries', slug: 'wildberries', logo_url: null,
        category: 'odezhda', coupons_count: 4, // не строка
    });

    __resetPoolForTest();
});

test('merchants-list: ?category=odezhda → параметр уходит в SQL', async () => {
    const pool = mockPool({ 'FROM public_data.merchants m': [] });
    __setPoolForTest(pool);

    await listMerchants(
        withOrigin({ httpMethod: 'GET', queryStringParameters: { category: 'odezhda' } }),
        {},
    );
    assert.equal(pool.calls.length, 1);
    assert.deepEqual(pool.calls[0].params, ['odezhda']);

    __resetPoolForTest();
});

test('merchants-list: OPTIONS → 204 + CORS', async () => {
    const res = await listMerchants(withOrigin({ httpMethod: 'OPTIONS' }), {});
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://gde-code.ru');
});

test('merchants-list: POST → 405', async () => {
    const res = await listMerchants({ httpMethod: 'POST' }, {});
    assert.equal(res.statusCode, 405);
});

test('merchants-list: чужой origin → CORS-заголовок не равен ему', async () => {
    __setPoolForTest(mockPool({}));
    const res = await listMerchants(
        withOrigin({ httpMethod: 'GET' }, 'https://evil.example.com'),
        {},
    );
    assert.notEqual(res.headers['Access-Control-Allow-Origin'], 'https://evil.example.com');
    assert.equal(res.headers['Access-Control-Allow-Origin'],    'https://gde-code.ru');
    __resetPoolForTest();
});

// -----------------------------------------------------------------------------
// GET /api/merchants/{id}
// -----------------------------------------------------------------------------

test('merchant-detail: возвращает merchant + coupons (code маскируется, даты ISO)', async () => {
    __setPoolForTest({
        async query(sql, params) {
            if (sql.includes('FROM public_data.merchants')) {
                return { rows: [{
                    id: 1, name: 'Wildberries', slug: 'wb', logo_url: null,
                    category: 'odezhda', created_at: new Date('2026-01-01T00:00:00Z'),
                }]};
            }
            if (sql.includes('FROM public_data.coupons')) {
                return { rows: [{
                    id: 10, title: 'Скидка 500', discount: '−500 ₽',
                    code: 'WB500RUB',
                    last_checked_at: new Date('2026-05-10T12:00:00Z'),
                    expires_at: null,
                    status: 'active',
                }]};
            }
            return { rows: [] };
        },
    });

    const res = await merchantDetail(
        withOrigin({ httpMethod: 'GET', pathParameters: { id: '1' } }),
        {},
    );
    assert.equal(res.statusCode, 200);
    const { merchant } = parseBody(res);
    assert.equal(merchant.id, 1);
    assert.equal(merchant.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(merchant.coupons.length, 1);
    assert.equal(merchant.coupons[0].code, 'XXXXXXXX'); // замаскирован
    assert.equal(merchant.coupons[0].last_checked_at, '2026-05-10T12:00:00.000Z');
    assert.equal(merchant.coupons[0].expires_at, null);

    __resetPoolForTest();
});

test('merchant-detail: 404 для несуществующего id', async () => {
    __setPoolForTest({ async query() { return { rows: [] }; } });
    const res = await merchantDetail(
        withOrigin({ httpMethod: 'GET', pathParameters: { id: '999' } }),
        {},
    );
    assert.equal(res.statusCode, 404);
    __resetPoolForTest();
});

test('merchant-detail: 400 для нечислового id', async () => {
    const res = await merchantDetail(
        withOrigin({ httpMethod: 'GET', pathParameters: { id: 'abc' } }),
        {},
    );
    assert.equal(res.statusCode, 400);
});

// -----------------------------------------------------------------------------
// GET /api/coupons
// -----------------------------------------------------------------------------

test('coupons-list: возвращает coupons + total/limit/offset, code маскирован', async () => {
    __setPoolForTest({
        async query(sql) {
            if (sql.includes('SELECT COUNT(*)')) return { rows: [{ total: '15' }] };
            return { rows: [{
                id: 1, title: 'T', discount: '−10%', code: 'CODE-X1',
                last_checked_at: new Date('2026-05-10T10:00:00Z'),
                expires_at: new Date('2026-06-01T00:00:00Z'),
                status: 'active',
                merchant_id: 5, merchant_name: 'WB', merchant_slug: 'wb',
                merchant_logo_url: null, merchant_category: 'odezhda',
            }]};
        },
    });

    const res = await listCoupons(
        withOrigin({ httpMethod: 'GET', queryStringParameters: { limit: '10', offset: '0' } }),
        {},
    );
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.equal(body.coupons.length, 1);
    assert.equal(body.coupons[0].code, 'XXXX-XX'); // дефис сохранён
    assert.equal(body.coupons[0].merchant.name, 'WB');
    assert.equal(body.coupons[0].last_checked_at, '2026-05-10T10:00:00.000Z');
    assert.equal(body.total, 15);
    assert.equal(body.limit, 10);
    assert.equal(body.offset, 0);

    __resetPoolForTest();
});

test('coupons-list: limit=999999 → 400 (выше MAX_LIMIT)', async () => {
    const res = await listCoupons(
        withOrigin({ httpMethod: 'GET', queryStringParameters: { limit: '999999' } }),
        {},
    );
    assert.equal(res.statusCode, 400);
});

test('coupons-list: limit/offset по умолчанию 20/0', async () => {
    const pool = mockPool({
        'SELECT COUNT(*)': [{ total: '0' }],
    });
    __setPoolForTest(pool);

    const res = await listCoupons(withOrigin({ httpMethod: 'GET' }), {});
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.equal(body.limit, 20);
    assert.equal(body.offset, 0);

    __resetPoolForTest();
});

test('coupons-list: ?merchant_id=abc → 400', async () => {
    const res = await listCoupons(
        withOrigin({ httpMethod: 'GET', queryStringParameters: { merchant_id: 'abc' } }),
        {},
    );
    assert.equal(res.statusCode, 400);
});

// -----------------------------------------------------------------------------
// GET /api/coupons/{id}
// -----------------------------------------------------------------------------

test('coupon-detail: возвращает 1 coupon, code замаскирован', async () => {
    __setPoolForTest({
        async query() {
            return { rows: [{
                id: 1, title: 'T', discount: '−10%', code: 'WB500RUB',
                last_checked_at: null, expires_at: null, status: 'active',
                merchant_id: 5, merchant_name: 'WB', merchant_slug: 'wb',
                merchant_logo_url: null, merchant_category: 'odezhda',
            }]};
        },
    });

    const res = await couponDetail(
        withOrigin({ httpMethod: 'GET', pathParameters: { id: '1' } }),
        {},
    );
    assert.equal(res.statusCode, 200);
    const { coupon } = parseBody(res);
    assert.equal(coupon.code, 'XXXXXXXX');
    assert.equal(coupon.merchant.name, 'WB');

    __resetPoolForTest();
});

test('coupon-detail: 404 для отсутствующего', async () => {
    __setPoolForTest({ async query() { return { rows: [] }; } });
    const res = await couponDetail(
        withOrigin({ httpMethod: 'GET', pathParameters: { id: '999' } }),
        {},
    );
    assert.equal(res.statusCode, 404);
    __resetPoolForTest();
});

// -----------------------------------------------------------------------------
// GET /health (Bearer)
// -----------------------------------------------------------------------------

test('health: без env-токена → 500 (мы НЕ хотим случайно публичный health)', async () => {
    const prev = process.env.PUBLIC_API_HEALTH_TOKEN;
    delete process.env.PUBLIC_API_HEALTH_TOKEN;

    const res = await healthHandler({ headers: { authorization: 'Bearer xxx' } }, {});
    assert.equal(res.statusCode, 500);

    if (prev !== undefined) process.env.PUBLIC_API_HEALTH_TOKEN = prev;
});

test('health: токен задан, без Bearer → 401', async () => {
    process.env.PUBLIC_API_HEALTH_TOKEN = 'secret-token-xyz';

    const res = await healthHandler({ headers: {} }, {});
    assert.equal(res.statusCode, 401);

    delete process.env.PUBLIC_API_HEALTH_TOKEN;
});

test('health: правильный Bearer → 200, db.ok=true', async () => {
    process.env.PUBLIC_API_HEALTH_TOKEN = 'secret-token-xyz';
    __setPoolForTest({ async query() { return { rows: [{ ok: 1 }] }; } });

    const res = await healthHandler({
        headers: { authorization: 'Bearer secret-token-xyz' },
    }, {});
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.equal(body.db, true);
    assert.equal(body.status, 'ok');

    __resetPoolForTest();
    delete process.env.PUBLIC_API_HEALTH_TOKEN;
});
