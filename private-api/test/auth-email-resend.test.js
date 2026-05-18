// =============================================================================
// auth-email-resend.test.js — handlers/auth/email/resend.js (6.4).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as resendHandler } from '../handlers/auth/email/resend.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    markUserEmailVerified,
    attachUnverifiedEmail,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';
const EMAIL = 'pending@example.com';

function makeEvent({ jwt = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
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

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// F26 — no_email_attached
// =============================================================================

test('F26: user без email привязки → 400 no_email_attached', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await resendHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'no_email_attached');
    resetTestAuthSecrets();
});

// =============================================================================
// F27 — already verified → no-op
// =============================================================================

test('F27: с verified email → 200 sent:false, already_verified:true, без отправки', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await markUserEmailVerified(pool, user_id, EMAIL);

    const { result: r, logs } = await captureLogs(() =>
        resendHandler(makeEvent({ jwt }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { sent: false, already_verified: true });

    // Никакого письма
    assert.ok(!logs.includes('[email mock]'));
    // Никаких новых токенов
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.email_verify_tokens`)).rows[0].c;
    assert.equal(c, 0);
    resetTestAuthSecrets();
});

// =============================================================================
// F28 — нормальный resend
// =============================================================================

test('F28: с НЕ-verified email → новый токен создан, мок отправил письмо', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, EMAIL);

    const { result: r, logs } = await captureLogs(() =>
        resendHandler(makeEvent({ jwt }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { sent: true });

    const tokens = await pool.query(
        `SELECT email, used_at FROM private_data.email_verify_tokens WHERE user_id = $1`, [user_id]);
    assert.equal(tokens.rows.length, 1);
    assert.equal(tokens.rows[0].used_at, null);

    // email-mock сработал
    assert.match(logs, /\[email mock\]/);
    assert.match(logs, /p\*\*\*@e\*\*\*\.com/);
    resetTestAuthSecrets();
});

// =============================================================================
// F29 — старый токен помечен used после resend
// =============================================================================

test('F29: старый неиспользованный токен после resend помечен used', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    // Старый токен (не used), created_at 2 минуты назад — чтобы не уперся в cooldown
    await pool.query(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at, created_at)
         VALUES ('old-resend-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $1, $2,
                 now() + interval '24 hours', now() - interval '2 minutes')`,
        [user_id, EMAIL],
    );

    await resendHandler(makeEvent({ jwt }), {}, { pool });

    const old = (await pool.query(
        `SELECT used_at FROM private_data.email_verify_tokens WHERE token LIKE 'old-resend%'`)).rows[0];
    assert.ok(old.used_at != null);

    // Активный должен быть один (свежий)
    const active = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.email_verify_tokens WHERE used_at IS NULL`)).rows[0].c;
    assert.equal(active, 1);
    resetTestAuthSecrets();
});

// =============================================================================
// F30 — общий счётчик rate-limit с attach
// =============================================================================

test('F30: rate-limit на resend использует тот же счётчик что и attach (1/60s)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, EMAIL);
    // Имитируем запрос attach 30 сек назад (used)
    await pool.query(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at, created_at, used_at)
         VALUES ('rl-shared-cccccccccccccccccccccccccccccccc', $1, $2, now() + interval '24 hours',
                 now() - interval '30 seconds', now())`,
        [user_id, EMAIL],
    );

    const r = await resendHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).error, 'rate_limited');
    resetTestAuthSecrets();
});

// =============================================================================
// F-bonus — без JWT
// =============================================================================

test('без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await resendHandler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

// =============================================================================
// G31 — email в логах маскирован при resend
// =============================================================================

test('G31: email в логах resend замаскирован, не полный', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, 'someone-private@private.io');

    const { logs } = await captureLogs(() =>
        resendHandler(makeEvent({ jwt }), {}, { pool }));
    assert.ok(!logs.includes('someone-private@private.io'), 'полный email в логе');
    assert.match(logs, /s\*\*\*@p\*\*\*\.io/);
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await resendHandler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await resendHandler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
