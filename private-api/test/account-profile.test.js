// =============================================================================
// account-profile.test.js — GET /api/account/profile + PATCH (6.7).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as getProfile    } from '../handlers/account/profile-get.js';
import { handler as patchProfile  } from '../handlers/account/profile-update.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    markUserEmailVerified,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const PHONE = '+79261234567';

function makeEvent({ body = null, jwt = null, method = 'GET', origin = 'https://gde-code.ru' } = {}) {
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

async function authedSetup(pool, phone = PHONE) {
    const { user_id } = await createTestUser(pool, phone);
    const { jwt } = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// A — GET /profile
// =============================================================================

test('A1: GET без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await getProfile(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('A2: GET возвращает phone_masked и поля профиля', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const r = await getProfile(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const p = parseBody(r).profile;
    assert.equal(p.phone_masked, '+7926***4567');
    assert.ok(!r.body.includes(PHONE), 'полный телефон не должен быть в ответе');
    assert.equal(p.display_name, null);
    assert.equal(p.email, null);
    assert.equal(p.email_verified, false);
    assert.ok(p.registered_at);
    assert.equal(p.profile_updated_at, null);
    assert.equal(p.banner_dismissed_count, 0);
    resetTestAuthSecrets();
});

test('A3: display_name = null если не задан', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await getProfile(makeEvent({ jwt }), {}, { pool });
    assert.equal(parseBody(r).profile.display_name, null);
    resetTestAuthSecrets();
});

test('A4: email_verified=true когда verified', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await markUserEmailVerified(pool, user_id, 'user@example.com');

    const r = await getProfile(makeEvent({ jwt }), {}, { pool });
    const p = parseBody(r).profile;
    assert.equal(p.email, 'user@example.com');
    assert.equal(p.email_verified, true);
    resetTestAuthSecrets();
});

// =============================================================================
// B — PATCH /profile
// =============================================================================

test('B5: PATCH без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await patchProfile(makeEvent({ body: { display_name: 'Alice' }, method: 'PATCH' }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('B6: валидный display_name → 200, поле обновлено', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await patchProfile(
        makeEvent({ body: { display_name: 'Alice' }, jwt, method: 'PATCH' }),
        {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).profile.display_name, 'Alice');

    const u = (await pool.query(
        `SELECT display_name FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.display_name, 'Alice');
    resetTestAuthSecrets();
});

test('B7: длинный display_name (>50) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);

    const long = 'a'.repeat(51);
    const r = await patchProfile(
        makeEvent({ body: { display_name: long }, jwt, method: 'PATCH' }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_display_name');
    resetTestAuthSecrets();
});

test('B8: только пробелы → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await patchProfile(
        makeEvent({ body: { display_name: '   ' }, jwt, method: 'PATCH' }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('B9: profile_updated_at заполняется после UPDATE', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    await patchProfile(
        makeEvent({ body: { display_name: 'X' }, jwt, method: 'PATCH' }),
        {}, { pool });
    const u = (await pool.query(
        `SELECT profile_updated_at FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.ok(u.profile_updated_at != null);
    resetTestAuthSecrets();
});

test('B-control: display_name с управляющими символами → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await patchProfile(
        makeEvent({ body: { display_name: 'Alice\nNewline' }, jwt, method: 'PATCH' }),
        {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('B-trim: display_name с пробелами по краям → trim, сохраняется без пробелов', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await patchProfile(
        makeEvent({ body: { display_name: '  Bob  ' }, jwt, method: 'PATCH' }),
        {}, { pool });
    const u = (await pool.query(
        `SELECT display_name FROM private_data.users WHERE id = $1`, [user_id])).rows[0];
    assert.equal(u.display_name, 'Bob');
    resetTestAuthSecrets();
});

// HTTP
test('OPTIONS GET → 204', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await getProfile(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('POST GET-profile → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await getProfile(makeEvent({ method: 'POST' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('GET PATCH-profile → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await patchProfile(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
