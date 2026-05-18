// =============================================================================
// auth-login-magic.test.js — handlers/auth/login-magic.js (6.3.6).
//
// Полный набор по плану: 19 тестов + HTTP-уровень.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as loginMagicHandler } from '../handlers/auth/login-magic.js';
import { verifyJwt } from '../lib/jwt.js';
import { userAgentHash } from '../lib/event.js';
import { requireUser } from '../lib/auth.js';
import {
    newPgMemPool,
    createTestUser,
    createTestMagicLinkToken,
    setTestAuthSecrets,
    resetTestAuthSecrets,
    eventWithBearer,
} from './helpers.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeEvent({ body, ip = '203.0.113.10', method = 'POST',
                     origin = 'https://gde-code.ru',
                     userAgent = 'Mozilla/5.0 (test)' } = {}) {
    return {
        httpMethod: method,
        headers: { origin, 'user-agent': userAgent },
        requestContext: ip ? { identity: { sourceIp: ip } } : undefined,
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

// =============================================================================
// Группа A — Валидация token
// =============================================================================

test('A1: нет body → 400 invalid_token', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await loginMagicHandler(makeEvent({ body: null }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_token');
    resetTestAuthSecrets();
});

test('A2: token пустой → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await loginMagicHandler(makeEvent({ body: { token: '' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A3: token слишком короткий → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const short = 'a'.repeat(20);
    const r = await loginMagicHandler(makeEvent({ body: { token: short } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A4: token слишком длинный → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const long = 'a'.repeat(100);
    const r = await loginMagicHandler(makeEvent({ body: { token: long } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A5: token с недопустимыми символами (+, /, =) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // Стандартный base64 (не -url) использует '+' и '/'
    const bad1 = 'a'.repeat(42) + '+';
    const bad2 = 'a'.repeat(42) + '/';
    const bad3 = 'a'.repeat(42) + '=';
    for (const t of [bad1, bad2, bad3]) {
        const r = await loginMagicHandler(makeEvent({ body: { token: t } }), {}, { pool });
        assert.equal(r.statusCode, 400, `token "${t.slice(-3)}" должен быть отклонён`);
    }
    resetTestAuthSecrets();
});

// =============================================================================
// Группа B — Token не найден / истёк / used
// =============================================================================

test('B6: token не в БД → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const fakeToken = 'a'.repeat(43);
    const r = await loginMagicHandler(makeEvent({ body: { token: fakeToken } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('B7: token истёк (>30 мин) → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id, expired: true });

    const r = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('B8: token уже использован (used_at NOT NULL) → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id, used: true });

    const r = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа C — Race condition
// =============================================================================

test('9: 5 параллельных login-magic с одним токеном → ровно 1 успех, 4 фейла', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const promises = Array.from({ length: 5 }, () =>
        loginMagicHandler(makeEvent({ body: { token } }), {}, { pool }));
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.statusCode === 200).length;
    const failures  = results.filter(r => r.statusCode === 401).length;
    assert.equal(successes, 1);
    assert.equal(failures,  4);

    // Должна быть ровно одна auth_session
    const sess = await pool.query(`SELECT count(*)::int AS c FROM private_data.auth_sessions`);
    assert.equal(sess.rows[0].c, 1);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа D — Sequential reuse
// =============================================================================

test('10-11-12: успех → второй вызов того же токена → 401, ровно 1 auth_session', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const r1 = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r1.statusCode, 200);

    const r2 = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r2.statusCode, 401);
    assert.equal(parseBody(r2).error, 'invalid_or_expired');

    const sess = await pool.query(`SELECT count(*)::int AS c FROM private_data.auth_sessions`);
    assert.equal(sess.rows[0].c, 1);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа E — Успех
// =============================================================================

test('13: валидный token → 200 { jwt }, без session_id в body', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const r = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.ok(typeof body.jwt === 'string');
    assert.equal(body.session_id, undefined);
    resetTestAuthSecrets();
});

test('14: JWT после login-magic проходит requireUser', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const r = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    const { jwt } = parseBody(r);

    const auth = await requireUser(eventWithBearer(jwt), { pool });
    assert.equal(auth.user_id, user_id);
    resetTestAuthSecrets();
});

test('15: session.user_id совпадает с user_id из magic_link_tokens', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const r = await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });
    const payload = await verifyJwt(parseBody(r).jwt);
    assert.equal(payload.sub, user_id);

    const sess = await pool.query(
        `SELECT user_id FROM private_data.auth_sessions LIMIT 1`);
    assert.equal(sess.rows[0].user_id, user_id);
    resetTestAuthSecrets();
});

test('16: session создана с TTL ≈ 90 дней', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    await loginMagicHandler(makeEvent({ body: { token } }), {}, { pool });

    const sess = await pool.query(
        `SELECT expires_at FROM private_data.auth_sessions LIMIT 1`);
    const ttlSec = Math.round((new Date(sess.rows[0].expires_at).getTime() - Date.now()) / 1000);
    const target = 90 * 24 * 3600;
    assert.ok(Math.abs(ttlSec - target) < 60, `TTL ≈ 90 дней, получено ${ttlSec}`);
    resetTestAuthSecrets();
});

test('17: user_agent_hash и ip_address сохранены в session', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const UA = 'Mozilla/5.0 LoginMagicTest';
    const IP = '198.51.100.7';
    await loginMagicHandler(
        makeEvent({ body: { token }, userAgent: UA, ip: IP }), {}, { pool });

    const sess = await pool.query(
        `SELECT user_agent_hash, ip_address FROM private_data.auth_sessions LIMIT 1`);
    assert.equal(sess.rows[0].user_agent_hash, userAgentHash(UA));
    assert.equal(String(sess.rows[0].ip_address), IP);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа F — Логи
// =============================================================================

test('18: при успехе в лог попадает маскированный token и IP', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const { logs } = await captureLogs(() =>
        loginMagicHandler(makeEvent({ body: { token }, ip: '198.51.100.42' }), {}, { pool }));
    // Маскированные присутствуют
    assert.match(logs, /token_mask/);
    assert.match(logs, new RegExp(`${token.slice(0, 4)}\\.\\.\\.${token.slice(-4)}`));
    assert.match(logs, /198\.51\.x\.x/);
    resetTestAuthSecrets();
});

test('19: в логах НИКОГДА не лежит token целиком', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    // Успешный путь
    const { logs: ok } = await captureLogs(() =>
        loginMagicHandler(makeEvent({ body: { token } }), {}, { pool }));
    assert.ok(!ok.includes(token), 'полный token в логе (успех)');

    // Неуспешный путь — повторное использование
    const { logs: fail } = await captureLogs(() =>
        loginMagicHandler(makeEvent({ body: { token } }), {}, { pool }));
    assert.ok(!fail.includes(token), 'полный token в логе (failure)');

    resetTestAuthSecrets();
});

// =============================================================================
// Документация поведения при сбое INSERT auth_sessions (симметрично verify-23)
// =============================================================================

test('20 (документация): сбой INSERT auth_sessions → токен used, 500, лог содержит причину', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { token } = await createTestMagicLinkToken(pool, { user_id });

    const failingPool = {
        query(sql, params) {
            if (typeof sql === 'string' && /INSERT\s+INTO\s+private_data\.auth_sessions/i.test(sql)) {
                return Promise.reject(new Error('simulated network failure'));
            }
            return pool.query(sql, params);
        },
    };
    const { result: r, logs } = await captureLogs(() =>
        loginMagicHandler(makeEvent({ body: { token } }), {}, { pool: failingPool }));

    assert.equal(r.statusCode, 500);
    // Токен остался used (не откатываем)
    const row = (await pool.query(
        `SELECT used_at FROM private_data.magic_link_tokens WHERE token = $1`, [token])).rows[0];
    assert.ok(row.used_at != null);
    assert.match(logs, /session_creation_failed/);
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204 corsPreflight', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await loginMagicHandler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await loginMagicHandler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('тело — не JSON → 400 invalid_token', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await loginMagicHandler(
        { httpMethod: 'POST', headers: {}, body: '{not_json' },
        {},
        { pool },
    );
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});
