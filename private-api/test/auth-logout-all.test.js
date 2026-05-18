// =============================================================================
// auth-logout-all.test.js — handlers/auth/logout-all.js (6.5).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as logoutAll } from '../handlers/auth/logout-all.js';
import { requireUser, AuthError } from '../lib/auth.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setTestAuthSecrets,
    resetTestAuthSecrets,
    eventWithBearer,
} from './helpers.js';

const PHONE_A = '+79261111111';
const PHONE_B = '+79262222222';

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

// =============================================================================
// 16-20
// =============================================================================

test('16: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await logoutAll(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('17: 3 живых сессии user → revoked_count=3', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE_A);
    const me = await createTestSession(pool, user_id);
    await createTestSession(pool, user_id);
    await createTestSession(pool, user_id);

    const r = await logoutAll(makeEvent({ jwt: me.jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).revoked_count, 3);
    resetTestAuthSecrets();
});

test('18: после logout-all все sessions помечены revoked_at', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE_A);
    const me = await createTestSession(pool, user_id);
    await createTestSession(pool, user_id);

    await logoutAll(makeEvent({ jwt: me.jwt }), {}, { pool });

    const rows = (await pool.query(
        `SELECT revoked_at FROM private_data.auth_sessions WHERE user_id = $1`, [user_id])).rows;
    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.ok(r.revoked_at != null, 'каждая сессия должна быть revoked');
    }
    resetTestAuthSecrets();
});

test('19: после logout-all → requireUser для тех сессий → AuthError(session_invalid)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE_A);
    const me    = await createTestSession(pool, user_id);
    const other = await createTestSession(pool, user_id);

    await logoutAll(makeEvent({ jwt: me.jwt }), {}, { pool });

    // Текущая (me.jwt) тоже отозвана — следующий requireUser упадёт.
    await assert.rejects(
        () => requireUser(eventWithBearer(me.jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_invalid' && e.cause === 'session_revoked',
    );
    await assert.rejects(
        () => requireUser(eventWithBearer(other.jwt), { pool }),
        (e) => e instanceof AuthError && e.code === 'session_invalid' && e.cause === 'session_revoked',
    );
    resetTestAuthSecrets();
});

test('20: изоляция — logout-all Алисы не затрагивает Боба', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id: aliceId } = await createTestUser(pool, PHONE_A);
    const aliceMe = await createTestSession(pool, aliceId);
    await createTestSession(pool, aliceId);

    const { user_id: bobId } = await createTestUser(pool, PHONE_B);
    const bobSession = await createTestSession(pool, bobId);
    await createTestSession(pool, bobId);

    await logoutAll(makeEvent({ jwt: aliceMe.jwt }), {}, { pool });

    // Сессии Алисы — все revoked
    const aliceRows = (await pool.query(
        `SELECT revoked_at FROM private_data.auth_sessions WHERE user_id = $1`, [aliceId])).rows;
    for (const r of aliceRows) assert.ok(r.revoked_at != null);

    // Сессии Боба — все живы
    const bobRows = (await pool.query(
        `SELECT revoked_at FROM private_data.auth_sessions WHERE user_id = $1`, [bobId])).rows;
    for (const r of bobRows) assert.equal(r.revoked_at, null);

    // Боб всё ещё может пройти requireUser
    const auth = await requireUser(eventWithBearer(bobSession.jwt), { pool });
    assert.equal(auth.user_id, bobId);
    resetTestAuthSecrets();
});

// =============================================================================
// Бонус — лог содержит маскированный sid инициатора, без полного
// =============================================================================

test('21: лог содержит triggered_by_sid_mask (head...tail), не полный sid', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE_A);
    const me = await createTestSession(pool, user_id);

    const origLog = console.log;
    const lines = [];
    console.log = (...args) =>
        lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    try {
        await logoutAll(makeEvent({ jwt: me.jwt }), {}, { pool });
    } finally {
        console.log = origLog;
    }
    const out = lines.join('\n');
    assert.match(out, /triggered_by_sid_mask/);
    assert.ok(!out.includes(me.session_id), 'полный session_id попал в лог');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await logoutAll(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await logoutAll(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
