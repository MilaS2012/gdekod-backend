// =============================================================================
// events-log.test.js — POST /api/events (6.11).
//
// Группа C из спеки 6.11. Каждый тест начинается с __resetCountersForTest():
// rate-limit держит счётчики в module-level Map, без сброса тесты влияют
// друг на друга (особенно когда несколько тестов используют один и тот же
// user_id через помощник).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/events/log.js';
import { __resetCountersForTest } from '../lib/events-rate-limit.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

function makeEvent({ jwt = null, body = null, method = 'POST',
                     headers = {} } = {}) {
    return {
        httpMethod: method,
        headers: { origin: 'https://gde-code.ru',
                   ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
                   ...headers },
        body: body == null ? null : JSON.stringify(body),
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool) {
    const { user_id } = await createTestUser(pool);
    const { jwt }     = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// C — /events POST
// =============================================================================

test('C1: без JWT → 401', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: { event_type: 'coupon_viewed' } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('C2: валидный event → 200 { ok: true } + INSERT в events_log', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'coupon_viewed', coupon_id: 42, payload: { source: 'list' } },
    }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { ok: true });
    assert.equal(parseBody(r).event_id, undefined,
                 'event_id НЕ должен возвращаться клиенту');

    const { rows } = await pool.query(
        `SELECT user_id, event_type, coupon_id, payload
           FROM private_data.events_log WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'coupon_viewed');
    assert.equal(rows[0].coupon_id, 42);
    assert.deepEqual(rows[0].payload, { source: 'list' });
    resetTestAuthSecrets();
});

test('C3: невалидный event_type → 400 invalid_event_type', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'malformed_event' },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_event_type');
    resetTestAuthSecrets();
});

test('C4: слишком большой payload (>4000 байт) → 400 payload_too_large', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    // 5000-символьная строка → JSON.stringify > 4000.
    const big = { data: 'x'.repeat(5000) };
    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'coupon_viewed', payload: big },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'payload_too_large');
    resetTestAuthSecrets();
});

test('C5: невалидный coupon_id (0 / negative / string) → 400 invalid_coupon_id', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    for (const bad of [0, -1, 'abc', 1.5]) {
        const r = await handler(makeEvent({
            jwt,
            body: { event_type: 'coupon_viewed', coupon_id: bad },
        }), {}, { pool });
        assert.equal(r.statusCode, 400, `coupon_id=${bad} должен дать 400`);
        assert.equal(parseBody(r).error, 'invalid_coupon_id');
    }
    resetTestAuthSecrets();
});

test('C6: превышен rate-limit (>60 за минуту) → 429 too_many_events', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    // 60 успешных
    for (let i = 0; i < 60; i++) {
        const r = await handler(makeEvent({
            jwt,
            body: { event_type: 'page_viewed' },
        }), {}, { pool });
        assert.equal(r.statusCode, 200, `event ${i + 1} должен пройти`);
    }
    // 61-й — 429
    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'page_viewed' },
    }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).error, 'too_many_events');
    resetTestAuthSecrets();
});

test('C7: ip_address и user_agent_hash сохраняются', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'merchant_viewed', merchant_id: 7 },
        headers: { 'user-agent': 'Mozilla/5.0 Test', 'x-forwarded-for': '203.0.113.5' },
    }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const { rows } = await pool.query(
        `SELECT ip_address::text AS ip, user_agent_hash
           FROM private_data.events_log WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ip, '203.0.113.5');
    // user_agent_hash — SHA-256, 64 hex.
    assert.match(rows[0].user_agent_hash, /^[0-9a-f]{64}$/);
    resetTestAuthSecrets();
});

test('C8: payload как JSONB корректно сохраняется и читается', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: {
            event_type: 'search_performed',
            payload: { q: 'тест', filters: { category: 'kids', sort: 'cheap' } },
        },
    }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const { rows } = await pool.query(
        `SELECT payload FROM private_data.events_log WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.q, 'тест');
    assert.equal(rows[0].payload.filters.category, 'kids');
    resetTestAuthSecrets();
});

test('C9: payload-массив отвергается → 400 invalid_payload', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'coupon_viewed', payload: [1, 2, 3] },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_payload');
    resetTestAuthSecrets();
});

test('C10: payload опущен — событие записывается с payload=NULL', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { event_type: 'page_viewed' },
    }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const { rows } = await pool.query(
        `SELECT payload FROM private_data.events_log WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows[0].payload, null);
    resetTestAuthSecrets();
});

test('C11: GET → 405 methodNotAllowed', async () => {
    __resetCountersForTest();
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
