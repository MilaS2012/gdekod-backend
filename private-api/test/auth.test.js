// =============================================================================
// auth.test.js — интеграционные тесты requireUser middleware (этап 6.3.2).
//
// Используем pg-mem с применёнными миграциями 001-006 (см. test/helpers.js).
// На каждый тест — свежий pg-mem-pool, чтобы изолировать состояние.
//
// JWT_SECRET для тестов выставляется глобально в test/helpers.js
// (TEST_JWT_SECRET). Каждый test setEnv / resetEnv.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { requireUser, extractBearerToken, AuthError } from '../lib/auth.js';
import { signJwt } from '../lib/jwt.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    eventWithBearer,
    setTestJwtSecret,
    resetTestJwtSecret,
    TEST_JWT_SECRET,
} from './helpers.js';

// -----------------------------------------------------------------------------
// AuthError API
// -----------------------------------------------------------------------------

test('AuthError: name, code, cause', () => {
    const e = new AuthError('jwt_invalid', 'oops', { cause: 'expired' });
    assert.equal(e.name,    'AuthError');
    assert.equal(e.code,    'jwt_invalid');
    assert.equal(e.cause,   'expired');
    assert.equal(e.message, 'oops');
    assert.ok(e instanceof Error);
});

// -----------------------------------------------------------------------------
// extractBearerToken (повтор минимума из 6.1 на всякий случай)
// -----------------------------------------------------------------------------

test('extractBearerToken: парсит "Bearer X" и игнорирует другие схемы', () => {
    assert.equal(extractBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
    assert.equal(extractBearerToken({ headers: { authorization: 'Basic xyz' } }),  null);
    assert.equal(extractBearerToken({ headers: {} }), null);
});

// =============================================================================
// Группа A — JWT-валидация
// =============================================================================

test('A1: нет Authorization header → AuthError(no_token)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    await assert.rejects(
        () => requireUser({ headers: {} }, { pool }),
        (e) => e instanceof AuthError && e.code === 'no_token',
    );
    resetTestJwtSecret();
});

test('A2: Authorization: Basic xyz → AuthError(malformed_token)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    await assert.rejects(
        () => requireUser({ headers: { authorization: 'Basic abc123' } }, { pool }),
        (e) => e instanceof AuthError && e.code === 'malformed_token',
    );
    resetTestJwtSecret();
});

test('A3: Authorization: Bearer (с пробелом, но без токена) → AuthError(malformed_token)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    await assert.rejects(
        () => requireUser({ headers: { authorization: 'Bearer ' } }, { pool }),
        (e) => e instanceof AuthError && e.code === 'malformed_token',
    );
    resetTestJwtSecret();
});

test('A4: истёкший JWT → AuthError(jwt_invalid, cause=expired)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // Сначала создаём сессию (живую), потом подменяем JWT на истёкший.
    const { session_id } = await createTestSession(pool, user_id);
    // Истёкший JWT через signJwt с отрицательным TTL не сделать (валидация),
    // поэтому собираем через jose напрямую.
    const { SignJWT } = await import('jose');
    const now = Math.floor(Date.now() / 1000);
    const expiredJwt = await new SignJWT({ sub: user_id, sid: session_id })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now - 7200)
        .setExpirationTime(now - 3600)
        .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    await assert.rejects(
        () => requireUser(eventWithBearer(expiredJwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'jwt_invalid' && e.cause === 'expired',
    );
    resetTestJwtSecret();
});

test('A5: подделанная подпись JWT → AuthError(jwt_invalid, cause=invalid)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    // JWT, подписанный ДРУГИМ секретом.
    const { SignJWT } = await import('jose');
    const otherSecret = 'OTHER-secret-min-32-bytes-BBBBBBBBBBBBBBB';
    const fakeJwt = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(otherSecret));

    await assert.rejects(
        () => requireUser(eventWithBearer(fakeJwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'jwt_invalid' && e.cause === 'invalid',
    );
    resetTestJwtSecret();
});

test('A6: malformed JWT (мусор) → AuthError(jwt_invalid, cause=malformed)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    await assert.rejects(
        () => requireUser(eventWithBearer('not.a.real.jwt'), { pool }),
        (e) => e instanceof AuthError && e.code === 'jwt_invalid' && e.cause === 'malformed',
    );
    resetTestJwtSecret();
});

// =============================================================================
// Группа B — Session валидация
// =============================================================================

test('B7: валидный JWT, но session_id не существует в БД → AuthError(session_invalid, cause=session_not_found)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const fakeSessionId = '00000000-0000-4000-8000-000000000000';
    const jwt = await signJwt({ sub: user_id, sid: fakeSessionId }, { ttlSeconds: 3600 });

    await assert.rejects(
        () => requireUser(eventWithBearer(jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_invalid' && e.cause === 'session_not_found',
    );
    resetTestJwtSecret();
});

test('B8: сессия отозвана (revoked_at NOT NULL) → AuthError(session_invalid, cause=session_revoked)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt } = await createTestSession(pool, user_id, { revoked: true });

    await assert.rejects(
        () => requireUser(eventWithBearer(jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_invalid' && e.cause === 'session_revoked',
    );
    resetTestJwtSecret();
});

test('B9: сессия истекла (expires_at в прошлом) → AuthError(session_invalid, cause=session_expired)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt } = await createTestSession(pool, user_id, { expired: true });

    await assert.rejects(
        () => requireUser(eventWithBearer(jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_invalid' && e.cause === 'session_expired',
    );
    resetTestJwtSecret();
});

test('B10: sub из JWT ≠ session.user_id → AuthError(session_mismatch)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id: aliceId } = await createTestUser(pool);
    const { user_id: bobId   } = await createTestUser(pool);
    // Создаём сессию для Боба, но JWT подписываем с sub Алисы — атака подмены.
    const { jwt } = await createTestSession(pool, bobId, { jwtSubOverride: aliceId });

    await assert.rejects(
        () => requireUser(eventWithBearer(jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_mismatch',
    );
    resetTestJwtSecret();
});

// =============================================================================
// Группа C — Успех + last_used_at
// =============================================================================

test('C11: валидный JWT + живая сессия → возвращает { user_id, session_id }', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt, session_id } = await createTestSession(pool, user_id);

    const r = await requireUser(eventWithBearer(jwt), { pool });
    assert.equal(r.user_id,    user_id);
    assert.equal(r.session_id, session_id);
    resetTestJwtSecret();
});

test('C12: после успешного requireUser → last_used_at обновился (был NULL → стал NOT NULL)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt, session_id } = await createTestSession(pool, user_id);

    const before = await pool.query(
        `SELECT last_used_at FROM private_data.auth_sessions WHERE session_id = $1`,
        [session_id],
    );
    assert.equal(before.rows[0].last_used_at, null, 'last_used_at должен быть NULL до первого использования');

    await requireUser(eventWithBearer(jwt), { pool });

    const after = await pool.query(
        `SELECT last_used_at FROM private_data.auth_sessions WHERE session_id = $1`,
        [session_id],
    );
    assert.ok(after.rows[0].last_used_at != null, 'last_used_at должен быть установлен после requireUser');
    resetTestJwtSecret();
});

test('C13: повторный requireUser → last_used_at обновляется заново (мониторим прогресс)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt, session_id } = await createTestSession(pool, user_id);

    await requireUser(eventWithBearer(jwt), { pool });
    const first = await pool.query(
        `SELECT last_used_at FROM private_data.auth_sessions WHERE session_id = $1`,
        [session_id],
    );
    const firstTs = new Date(first.rows[0].last_used_at).getTime();

    // Микропауза — чтобы now() гарантированно отличалось.
    await new Promise(r => setTimeout(r, 10));

    await requireUser(eventWithBearer(jwt), { pool });
    const second = await pool.query(
        `SELECT last_used_at FROM private_data.auth_sessions WHERE session_id = $1`,
        [session_id],
    );
    const secondTs = new Date(second.rows[0].last_used_at).getTime();

    assert.ok(secondTs >= firstTs, 'last_used_at не должен убывать между запросами');
    resetTestJwtSecret();
});

// =============================================================================
// Дополнительно — безопасность логов
// =============================================================================

// ─── Логирование: маскирование sid + различение causes ─────────────────────

async function captureWarnsDuring(fn) {
    const orig = console.warn;
    const lines = [];
    console.warn = (...args) =>
        lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    try { await fn(); }
    finally { console.warn = orig; }
    return lines.join('\n');
}

test('лог: session_id маскируется (не утекает в console.warn)', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const fakeSid = '12345678-1234-4abc-8def-abcdef123456';
    const jwt = await signJwt({ sub: user_id, sid: fakeSid }, { ttlSeconds: 3600 });

    const out = await captureWarnsDuring(async () => {
        await assert.rejects(() => requireUser(eventWithBearer(jwt), { pool }), AuthError);
    });
    assert.ok(!out.includes(fakeSid),       'полный session_id попал в лог');
    assert.ok(out.includes('1234...3456'),  'маскированный session_id ожидался в логе');
    resetTestJwtSecret();
});

test('лог 15: revoked сессия → cause:"session_revoked" в console.warn', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt } = await createTestSession(pool, user_id, { revoked: true });

    const out = await captureWarnsDuring(async () => {
        await assert.rejects(() => requireUser(eventWithBearer(jwt), { pool }), AuthError);
    });
    assert.match(out, /session_invalid/);
    assert.match(out, /session_revoked/);
    assert.doesNotMatch(out, /session_expired/);
    assert.doesNotMatch(out, /session_not_found/);
    resetTestJwtSecret();
});

test('лог 16: expired сессия → cause:"session_expired" в console.warn', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt } = await createTestSession(pool, user_id, { expired: true });

    const out = await captureWarnsDuring(async () => {
        await assert.rejects(() => requireUser(eventWithBearer(jwt), { pool }), AuthError);
    });
    assert.match(out, /session_expired/);
    assert.doesNotMatch(out, /session_revoked/);
    assert.doesNotMatch(out, /session_not_found/);
    resetTestJwtSecret();
});

test('лог 17: session_id не в БД → cause:"session_not_found" в console.warn', async () => {
    setTestJwtSecret();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const fakeSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const jwt = await signJwt({ sub: user_id, sid: fakeSid }, { ttlSeconds: 3600 });

    const out = await captureWarnsDuring(async () => {
        await assert.rejects(() => requireUser(eventWithBearer(jwt), { pool }), AuthError);
    });
    assert.match(out, /session_not_found/);
    assert.doesNotMatch(out, /session_revoked/);
    assert.doesNotMatch(out, /session_expired/);
    resetTestJwtSecret();
});
