// =============================================================================
// auth-banner-dismiss.test.js — handlers/auth/banner-dismiss.js (6.5).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/auth/banner-dismiss.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

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

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// 1. Без JWT → 401
// =============================================================================

test('1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

// =============================================================================
// 2-4. Инкремент dismissed_count, hidden_permanently после 3
// =============================================================================

test('2: первый dismiss → count=1, hidden_permanently=false', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { dismissed_count: 1, hidden_permanently: false });
    resetTestAuthSecrets();
});

test('3: второй dismiss → count=2, hidden=false', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    await handler(makeEvent({ jwt }), {}, { pool });
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(parseBody(r).dismissed_count, 2);
    assert.equal(parseBody(r).hidden_permanently, false);
    resetTestAuthSecrets();
});

test('4: третий dismiss → count=3, hidden_permanently=true', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    await handler(makeEvent({ jwt }), {}, { pool });
    await handler(makeEvent({ jwt }), {}, { pool });
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(parseBody(r).dismissed_count, 3);
    assert.equal(parseBody(r).hidden_permanently, true);
    resetTestAuthSecrets();
});

test('5: четвёртый dismiss → count=4, hidden=true (не сбрасывается)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    for (let i = 0; i < 4; i++) {
        await handler(makeEvent({ jwt }), {}, { pool });
    }
    // Проверяем БД
    const u = (await pool.query(
        `SELECT email_reminder_dismissed_count FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.email_reminder_dismissed_count, 4);

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(parseBody(r).dismissed_count, 5);
    assert.equal(parseBody(r).hidden_permanently, true);
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

test('GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
