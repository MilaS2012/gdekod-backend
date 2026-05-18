// =============================================================================
// auth-sessions.test.js — handlers/auth/sessions.js (GET /api/auth/sessions) (6.5).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/auth/sessions.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ jwt = null, query = null, method = 'GET',
                     origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        queryStringParameters: query,
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt, session_id } = await createTestSession(pool, user_id);
    return { user_id, jwt, session_id };
}

// =============================================================================
// Валидация
// =============================================================================

test('6: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('7: limit невалидный → 400 invalid_limit', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    for (const bad of ['abc', '0', '-5', '21', '100']) {
        const r = await handler(makeEvent({ jwt, query: { limit: bad } }), {}, { pool });
        assert.equal(r.statusCode, 400, `limit=${bad} должен быть отвергнут`);
        assert.equal(parseBody(r).error, 'invalid_limit');
    }
    resetTestAuthSecrets();
});

// =============================================================================
// Базовая логика
// =============================================================================

test('8: одна живая сессия → 1 запись, is_current=true', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt, session_id } = await authedSetup(pool);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].session_id, session_id);
    assert.equal(body.sessions[0].is_current, true);
    resetTestAuthSecrets();
});

test('9: 2 сессии одного user → 2 записи, current первая, is_current корректно', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    const sessionA = await createTestSession(pool, user_id);
    const sessionB = await createTestSession(pool, user_id);

    // Запрос JWT'ом сессии B
    const r = await handler(makeEvent({ jwt: sessionB.jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.sessions.length, 2);
    assert.equal(body.sessions[0].session_id, sessionB.session_id, 'current (B) должна быть первой');
    assert.equal(body.sessions[0].is_current, true);
    assert.equal(body.sessions[1].session_id, sessionA.session_id);
    assert.equal(body.sessions[1].is_current, false);
    resetTestAuthSecrets();
});

test('10: revoked сессии не в списке', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    const live = await createTestSession(pool, user_id);
    await createTestSession(pool, user_id, { revoked: true });

    const r = await handler(makeEvent({ jwt: live.jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].session_id, live.session_id);
    resetTestAuthSecrets();
});

test('11: expired сессии не в списке', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    const live = await createTestSession(pool, user_id);
    await createTestSession(pool, user_id, { expired: true });

    const r = await handler(makeEvent({ jwt: live.jwt }), {}, { pool });
    assert.equal(parseBody(r).sessions.length, 1);
    resetTestAuthSecrets();
});

test('12: изоляция — сессии другого user не видны', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const alice = await authedSetup(pool, '+79261111111');
    const bob   = await createTestUser(pool, '+79262222222');
    await createTestSession(pool, bob.user_id);  // у Боба своя сессия

    const r = await handler(makeEvent({ jwt: alice.jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].session_id, alice.session_id);
    resetTestAuthSecrets();
});

test('13: limit ограничивает результат', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    const me = await createTestSession(pool, user_id);
    for (let i = 0; i < 4; i++) await createTestSession(pool, user_id);

    const r = await handler(makeEvent({ jwt: me.jwt, query: { limit: '3' } }), {}, { pool });
    assert.equal(parseBody(r).sessions.length, 3);
    resetTestAuthSecrets();
});

// =============================================================================
// Безопасность
// =============================================================================

test('14: ip_masked всегда замаскирован (не полный IP)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    // Создаём сессию с конкретным IP
    const session_id = (await pool.query(
        `INSERT INTO private_data.auth_sessions (user_id, expires_at, ip_address)
         VALUES ($1, now() + interval '90 days', '198.51.100.42')
         RETURNING session_id`, [user_id])).rows[0].session_id;
    // Подделываем JWT под эту сессию
    const { signJwt } = await import('../lib/jwt.js');
    const jwt = await signJwt({ sub: user_id, sid: session_id }, { ttlSeconds: 3600 });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.sessions[0].ip_masked, '198.51.x.x');
    assert.ok(!r.body.includes('198.51.100.42'), 'полный IP попал в тело ответа');
    resetTestAuthSecrets();
});

test('15: device_info = user_agent_summary, "Unknown device" если NULL', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);

    // Сессия 1: с user_agent_summary
    const s1 = (await pool.query(
        `INSERT INTO private_data.auth_sessions
           (user_id, expires_at, user_agent_summary, last_used_at)
         VALUES ($1, now() + interval '90 days', 'Chrome 120 on macOS', now() - interval '1 minute')
         RETURNING session_id`, [user_id])).rows[0].session_id;
    // Сессия 2: без summary (NULL)
    const s2 = (await pool.query(
        `INSERT INTO private_data.auth_sessions
           (user_id, expires_at)
         VALUES ($1, now() + interval '90 days')
         RETURNING session_id`, [user_id])).rows[0].session_id;

    const { signJwt } = await import('../lib/jwt.js');
    const jwt = await signJwt({ sub: user_id, sid: s2 }, { ttlSeconds: 3600 });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    const body = parseBody(r);
    // s2 — current, s1 — second
    const cur   = body.sessions.find(s => s.session_id === s2);
    const other = body.sessions.find(s => s.session_id === s1);
    assert.equal(cur.device_info,   'Unknown device');
    assert.equal(other.device_info, 'Chrome 120 on macOS');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('POST → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'POST' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
