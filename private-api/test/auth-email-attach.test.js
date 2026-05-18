// =============================================================================
// auth-email-attach.test.js — handlers/auth/email/attach.js (6.4).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as attachHandler } from '../handlers/auth/email/attach.js';
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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeEvent({ body, jwt = null, method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
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

async function newAuthedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// Группа A — Валидация
// =============================================================================

test('A1: без JWT → 401 unauthorized', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await attachHandler(
        makeEvent({ body: { email: 'a@b.com' } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('A2: невалидный email (без @, без домена, пустой) → 400 invalid_email', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await newAuthedSetup(pool);

    for (const email of ['no-at', '@nolocal.com', 'noat-no-dot', '', 'a@b']) {
        const r = await attachHandler(makeEvent({ body: { email }, jwt }), {}, { pool });
        assert.equal(r.statusCode, 400, `email="${email}" должен быть отвергнут`);
        assert.equal(parseBody(r).error, 'invalid_email');
    }
    resetTestAuthSecrets();
});

test('A3: email > 254 символов → 400 invalid_email', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await newAuthedSetup(pool);
    const longLocal = 'a'.repeat(250);
    const r = await attachHandler(makeEvent({ body: { email: `${longLocal}@b.com` }, jwt }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа B — Логика
// =============================================================================

test('B4: новый email → 200 sent:true, токен создан, мок отправил письмо', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);

    const { result: r, logs } = await captureLogs(() =>
        attachHandler(makeEvent({ body: { email: 'newuser@example.com' }, jwt }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { sent: true });

    // Токен создан
    const tokens = await pool.query(
        `SELECT email, used_at FROM private_data.email_verify_tokens WHERE user_id = $1`, [user_id]);
    assert.equal(tokens.rows.length, 1);
    assert.equal(tokens.rows[0].email, 'newuser@example.com');
    assert.equal(tokens.rows[0].used_at, null);

    // users.email обновлён
    const u = (await pool.query(
        `SELECT email, email_verified_at FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.email, 'newuser@example.com');
    assert.equal(u.email_verified_at, null);

    // Мок-провайдер пишет в лог замаскированный email
    assert.match(logs, /\[email mock\]/);
    assert.match(logs, /n\*\*\*@e\*\*\*\.com/);
    resetTestAuthSecrets();
});

test('B5: тот же email что уже привязан и verified → 200 sent:false, already_verified:true', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    await markUserEmailVerified(pool, user_id, 'verified@example.com');

    const { result: r, logs } = await captureLogs(() =>
        attachHandler(makeEvent({ body: { email: 'verified@example.com' }, jwt }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { sent: false, already_verified: true });

    // НИКАКОЙ токен не создан
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.email_verify_tokens`)).rows[0].c;
    assert.equal(c, 0);

    // НИКАКОГО письма не отправлено
    assert.ok(!logs.includes('[email mock]'), 'мок-провайдер не должен вызываться');
    resetTestAuthSecrets();
});

test('B6: тот же email что привязан, но НЕ verified → старый токен used, новый создан', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, 'pending@example.com');
    // Старый токен (created_at 2 минуты назад — чтобы не упереться в cooldown 60s)
    const oldCreated = new Date(Date.now() - 2 * 60 * 1000);
    const oldExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at, created_at)
         VALUES ('old-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $1, $2, $3, $4)`,
        [user_id, 'pending@example.com', oldExpires, oldCreated],
    );

    const r = await attachHandler(
        makeEvent({ body: { email: 'pending@example.com' }, jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);

    // Старый токен помечен used, новый — нет
    const old = (await pool.query(
        `SELECT used_at FROM private_data.email_verify_tokens WHERE token LIKE 'old-token%'`)).rows[0];
    assert.ok(old.used_at != null, 'старый токен должен быть used');

    const active = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.email_verify_tokens WHERE used_at IS NULL`)).rows[0].c;
    assert.equal(active, 1);
    resetTestAuthSecrets();
});

test('B7: другой email при существующем НЕ-verified → users.email перезаписан, старый токен used', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, 'first@example.com');
    const oldCreated = new Date(Date.now() - 2 * 60 * 1000);
    const oldExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at, created_at)
         VALUES ('old-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', $1, $2, $3, $4)`,
        [user_id, 'first@example.com', oldExpires, oldCreated],
    );

    const r = await attachHandler(
        makeEvent({ body: { email: 'second@example.com' }, jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const u = (await pool.query(
        `SELECT email, email_verified_at FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.email, 'second@example.com');
    assert.equal(u.email_verified_at, null);

    const old = (await pool.query(
        `SELECT used_at FROM private_data.email_verify_tokens WHERE token LIKE 'old-token%'`)).rows[0];
    assert.ok(old.used_at != null);
    resetTestAuthSecrets();
});

test('B8: email уже у другого user → 409 email_taken', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // user A уже занял email
    const { user_id: userA } = await createTestUser(pool, '+79261111111');
    await markUserEmailVerified(pool, userA, 'taken@example.com');

    // user B пытается привязать тот же email
    const { jwt: jwtB } = await newAuthedSetup(pool, '+79262222222');
    const r = await attachHandler(
        makeEvent({ body: { email: 'taken@example.com' }, jwt: jwtB }), {}, { pool });
    assert.equal(r.statusCode, 409);
    assert.equal(parseBody(r).error, 'email_taken');
    resetTestAuthSecrets();
});

test('B9: different email + verified → 409 email_change_requires_old_email_confirmation', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    await markUserEmailVerified(pool, user_id, 'verified@example.com');

    const { result: r, logs } = await captureLogs(() =>
        attachHandler(makeEvent({ body: { email: 'newone@example.com' }, jwt }), {}, { pool }));
    assert.equal(r.statusCode, 409);
    const body = parseBody(r);
    assert.equal(body.error,   'email_change_requires_old_email_confirmation');
    assert.match(body.message, /старый email|поддержкой/);

    // email в users НЕ меняется
    const u = (await pool.query(
        `SELECT email, email_verified_at FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.email, 'verified@example.com');
    assert.ok(u.email_verified_at != null);

    // В лог попадает reason для аудита (попытки смены — потенциальная атака)
    assert.match(logs, /verified_email_already_attached/);
    resetTestAuthSecrets();
});

test('B10: attempt="new" в логе при первой привязке', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await newAuthedSetup(pool);

    const { logs } = await captureLogs(() =>
        attachHandler(makeEvent({ body: { email: 'first@example.com' }, jwt }), {}, { pool }));
    assert.match(logs, /"attempt":"new"/);
    resetTestAuthSecrets();
});

test('B11: attempt="replace_unverified" в логе при перепривязке', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    await attachUnverifiedEmail(pool, user_id, 'first@example.com');

    const { logs } = await captureLogs(() =>
        attachHandler(makeEvent({ body: { email: 'second@example.com' }, jwt }), {}, { pool }));
    assert.match(logs, /"attempt":"replace_unverified"/);
    resetTestAuthSecrets();
});

test('B12: email сохраняется в lowercase (нормализация)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);

    await attachHandler(
        makeEvent({ body: { email: 'User@Example.COM' }, jwt }), {}, { pool });
    const u = (await pool.query(
        `SELECT email FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.email, 'user@example.com');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа C — Rate-limit
// =============================================================================

test('C13: 2 запроса за 30 сек → второй 429 cooldown', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    // Вставляем «использованный» токен 30 сек назад — имитирует первый attach
    await pool.query(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at, created_at, used_at)
         VALUES ('rl-30s-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $1, $2, now() + interval '24 hours',
                 now() - interval '30 seconds', now())`,
        [user_id, 'a@b.com'],
    );

    const r = await attachHandler(
        makeEvent({ body: { email: 'c@d.com' }, jwt }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).error, 'rate_limited');
    assert.ok(r.headers['Retry-After']);
    resetTestAuthSecrets();
});

test('C14: 5 attempts за сутки → 6-й 429 daily_limit', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await newAuthedSetup(pool);
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
        const createdAt = new Date(Date.now() - (120 + i * 60) * 1000);
        await pool.query(
            `INSERT INTO private_data.email_verify_tokens
               (token, user_id, email, expires_at, created_at, used_at)
             VALUES ($1, $2, $3, $4, $5, now())`,
            [`rl-day-${String(i).padStart(40, '0')}`, user_id, 'a@b.com', expires, createdAt],
        );
    }
    const r = await attachHandler(
        makeEvent({ body: { email: 'c@d.com' }, jwt }), {}, { pool });
    assert.equal(r.statusCode, 429);
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204 corsPreflight', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await attachHandler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405 method not allowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await attachHandler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
