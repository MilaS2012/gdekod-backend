// =============================================================================
// auth-email-verify.test.js — handlers/auth/email/verify.js (6.4).
//
// ПУБЛИЧНЫЙ endpoint (без JWT). Юзер кликает по ссылке из письма.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as verifyHandler } from '../handlers/auth/email/verify.js';
import {
    newPgMemPool,
    createTestUser,
    createTestVerifyToken,
    attachUnverifiedEmail,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';
const EMAIL = 'pending@example.com';

function makeEvent({ body, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin },
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
// Группа D — Валидация token
// =============================================================================

test('D15: без body / без token → 400 invalid_token', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r1 = await verifyHandler(makeEvent({ body: null }), {}, { pool });
    const r2 = await verifyHandler(makeEvent({ body: {} }), {}, { pool });
    const r3 = await verifyHandler(makeEvent({ body: { token: '' } }), {}, { pool });
    assert.equal(r1.statusCode, 400);
    assert.equal(r2.statusCode, 400);
    assert.equal(r3.statusCode, 400);
    resetTestAuthSecrets();
});

test('D16: token с недопустимыми символами (+, /, =) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    for (const bad of ['a'.repeat(42) + '+', 'a'.repeat(42) + '/', 'a'.repeat(42) + '=']) {
        const r = await verifyHandler(makeEvent({ body: { token: bad } }), {}, { pool });
        assert.equal(r.statusCode, 400, `token ".${bad.slice(-3)}" должен быть отвергнут`);
    }
    resetTestAuthSecrets();
});

test('D17: token короткий (< 40) или длинный (> 48) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r1 = await verifyHandler(makeEvent({ body: { token: 'a'.repeat(30) } }), {}, { pool });
    const r2 = await verifyHandler(makeEvent({ body: { token: 'a'.repeat(60) } }), {}, { pool });
    assert.equal(r1.statusCode, 400);
    assert.equal(r2.statusCode, 400);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа E — Логика
// =============================================================================

test('E18: валидный токен → 200 verified:true + email_mask (не полный email)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL });

    const r = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.verified, true);
    assert.equal(body.email_mask, 'p***@e***.com');
    assert.equal(body.email, undefined, 'полный email не должен быть в ответе');
    resetTestAuthSecrets();
});

test('E19: после verify users.email_verified_at установлен', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL });

    await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    const u = (await pool.query(
        `SELECT email_verified_at FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.ok(u.email_verified_at != null);
    resetTestAuthSecrets();
});

test('E20: после verify все остальные токены user помечены used (одноразовость на уровне user_id)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token: t1 } = await createTestVerifyToken(pool, { user_id, email: EMAIL });
    const { token: t2 } = await createTestVerifyToken(pool, { user_id, email: EMAIL });

    await verifyHandler(makeEvent({ body: { token: t1 } }), {}, { pool });

    const rows = await pool.query(
        `SELECT token, used_at FROM private_data.email_verify_tokens WHERE user_id = $1`, [user_id]);
    for (const r of rows.rows) {
        assert.ok(r.used_at != null, `токен ${r.token.slice(0, 6)}... должен быть used`);
    }
    resetTestAuthSecrets();
});

test('E21: token не существует в БД → 410 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const fakeToken = 'a'.repeat(43);
    const r = await verifyHandler(makeEvent({ body: { token: fakeToken } }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('E22: token истёк (>24 часа) → 410', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL, expired: true });

    const r = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 410);
    resetTestAuthSecrets();
});

test('E23: token уже использован → 410', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL, used: true });

    const r = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r.statusCode, 410);
    resetTestAuthSecrets();
});

test('E24: sequential reuse — успех → второй verify тем же токеном → 410', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL });

    const r1 = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    const r2 = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 410);
    resetTestAuthSecrets();
});

test('E25: race — 5 параллельных verify с одним токеном → ровно 1 успех, 4 фейла', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    const { token } = await createTestVerifyToken(pool, { user_id, email: EMAIL });

    const results = await Promise.all(
        Array.from({ length: 5 }, () =>
            verifyHandler(makeEvent({ body: { token } }), {}, { pool })));
    const successes = results.filter(r => r.statusCode === 200).length;
    const failures  = results.filter(r => r.statusCode === 410).length;
    assert.equal(successes, 1);
    assert.equal(failures,  4);
    resetTestAuthSecrets();
});

// =============================================================================
// Бонусные тесты безопасности
// =============================================================================

test('G33: ответ verify не содержит полный email — только email_mask', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await attachUnverifiedEmail(pool, user_id, 'secret-email@private.org');
    const { token } = await createTestVerifyToken(pool, { user_id, email: 'secret-email@private.org' });

    const r = await verifyHandler(makeEvent({ body: { token } }), {}, { pool });
    assert.ok(!r.body.includes('secret-email@private.org'));
    assert.ok(r.body.includes('s***@p***.org'));
    resetTestAuthSecrets();
});

test('G34: ответ verify одинаков для трёх причин фейла (не найден / истёк / used)', async () => {
    setTestAuthSecrets();
    // 3 разных pool
    const poolA = await newPgMemPool();
    const poolB = await newPgMemPool();
    const poolC = await newPgMemPool();
    for (const p of [poolB, poolC]) {
        const { user_id } = await createTestUser(p, PHONE);
        await attachUnverifiedEmail(p, user_id, EMAIL);
    }
    const tokA = 'a'.repeat(43); // несуществующий
    const { token: tokB } = await createTestVerifyToken(poolB,
        { user_id: (await poolB.query(`SELECT id FROM private_data.users LIMIT 1`)).rows[0].id,
          email: EMAIL, expired: true });
    const { token: tokC } = await createTestVerifyToken(poolC,
        { user_id: (await poolC.query(`SELECT id FROM private_data.users LIMIT 1`)).rows[0].id,
          email: EMAIL, used: true });

    const ra = await verifyHandler(makeEvent({ body: { token: tokA } }), {}, { pool: poolA });
    const rb = await verifyHandler(makeEvent({ body: { token: tokB } }), {}, { pool: poolB });
    const rc = await verifyHandler(makeEvent({ body: { token: tokC } }), {}, { pool: poolC });

    assert.equal(ra.statusCode, 410);
    assert.equal(rb.statusCode, 410);
    assert.equal(rc.statusCode, 410);
    assert.deepEqual(parseBody(ra), parseBody(rb));
    assert.deepEqual(parseBody(rb), parseBody(rc));
    resetTestAuthSecrets();
});

test('G32: token в логах замаскирован (head...tail, не полный)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const fakeToken = 'distinctABCD1234567890XYZ_zzzzzzzzzz_END01';
    const { logs } = await captureLogs(() =>
        verifyHandler(makeEvent({ body: { token: fakeToken } }), {}, { pool }));
    assert.ok(!logs.includes(fakeToken), 'полный token попал в лог');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
