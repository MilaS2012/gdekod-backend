// =============================================================================
// account-delete-confirm.test.js — POST /api/account/delete-confirm (6.9).
//
// Группа C из спеки. Проверка OTP (brute-force защита 5 попыток),
// soft-delete (scheduled_at = now+24h), revoke всех сессий, cancel подписки.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/account/delete-confirm.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createDeletionOtp,
    createTestSubscription,
    setUserDeletion,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';
import { DELETION_GRACE_PERIOD_HOURS } from '../lib/account-deletion-config.js';

const VALID_OTP_CODE = '654321';

function makeEvent({ jwt = null, body = null, method = 'POST' } = {}) {
    return {
        httpMethod: method,
        headers: { origin: 'https://gde-code.ru',
                   ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        body: body == null ? null : JSON.stringify(body),
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool) {
    const { user_id, phone } = await createTestUser(pool);
    const { jwt, session_id } = await createTestSession(pool, user_id);
    return { user_id, phone, jwt, session_id };
}

// =============================================================================
// C — /account/delete-confirm
// =============================================================================

test('C1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('C2: невалидный формат OTP (не 6 цифр) → 400 invalid_input', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, body: { otp_code: '123' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_input');
    resetTestAuthSecrets();
});

test('C3: уже completed → 410 already_deleted', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600, completed: true });
    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'already_deleted');
    resetTestAuthSecrets();
});

test('C4: уже pending → 409 deletion_already_pending', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: -3600 });
    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 409);
    assert.equal(parseBody(r).error, 'deletion_already_pending');
    resetTestAuthSecrets();
});

test('C5: нет активного OTP → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('C6: неверный OTP → 401, attempts_count инкрементируется', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });

    const r = await handler(makeEvent({ jwt, body: { otp_code: '000000' } }), {}, { pool });
    assert.equal(r.statusCode, 401);

    const { rows } = await pool.query(
        `SELECT attempts_count FROM private_data.account_deletion_otp_codes
          WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows[0].attempts_count, 1);
    resetTestAuthSecrets();
});

test('C7: 5 неверных попыток → too_many_attempts, OTP погашен', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE, attempts: 5 });

    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'too_many_attempts');

    const { rows } = await pool.query(
        `SELECT used_at FROM private_data.account_deletion_otp_codes
          WHERE user_id = $1`,
        [user_id],
    );
    assert.ok(rows[0].used_at != null, 'OTP должен быть погашен после too_many_attempts');
    resetTestAuthSecrets();
});

test('C8: валидный OTP → 200, scheduled_at ~now+24h, sessions revoked', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });
    const before = Date.now();

    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.grace_period_hours, DELETION_GRACE_PERIOD_HOURS);
    assert.equal(body.cancel_url, '/api/account/cancel-deletion');

    const scheduled = new Date(body.deletion_scheduled_at).getTime();
    const expected  = before + DELETION_GRACE_PERIOD_HOURS * 3600 * 1000;
    assert.ok(Math.abs(scheduled - expected) < 5000,
              `scheduled_at должен быть ~now+24h, diff=${scheduled - expected}ms`);

    // Все сессии user'а revoked.
    const { rows } = await pool.query(
        `SELECT count(*)::int AS c
           FROM private_data.auth_sessions
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [user_id],
    );
    assert.equal(rows[0].c, 0, 'все сессии должны быть revoked');
    resetTestAuthSecrets();
});

test('C9: confirm также отменяет активную подписку', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });
    await createTestSubscription(pool, user_id,
                                 { tariff: 'daily_35', status: 'active' });

    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const { rows } = await pool.query(
        `SELECT status, cancelled_at, next_charge_at
           FROM private_data.subscriptions WHERE user_id = $1`,
        [user_id],
    );
    assert.equal(rows[0].status, 'cancelled');
    assert.ok(rows[0].cancelled_at != null);
    assert.equal(rows[0].next_charge_at, null);
    resetTestAuthSecrets();
});

test('C10: confirm пишет events_log deletion_scheduled', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });

    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 200);

    const { rows } = await pool.query(
        `SELECT event_type FROM private_data.events_log
          WHERE user_id = $1 AND event_type = 'deletion_scheduled'`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    resetTestAuthSecrets();
});

test('C11: изоляция — confirm одного user не трогает другого', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id: u1, jwt: jwt1 } = await authedSetup(pool);
    const { user_id: u2 } = await createTestUser(pool);
    const { jwt: jwt2 } = await createTestSession(pool, u2);
    await createDeletionOtp(pool, u1, { code: VALID_OTP_CODE });

    const r1 = await handler(makeEvent({ jwt: jwt1, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r1.statusCode, 200);

    // u2: scheduled_at должен остаться NULL.
    const u2State = (await pool.query(
        `SELECT deletion_scheduled_at FROM private_data.users WHERE id = $1`,
        [u2],
    )).rows[0];
    assert.equal(u2State.deletion_scheduled_at, null);

    // Сессия u2 не revoked.
    const sess = await handler(makeEvent({ jwt: jwt2, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    // У u2 нет OTP — ответ 401 invalid_or_expired. Главное — что
    // requireUser прошёл (т.е. сессия u2 не revoked).
    assert.equal(sess.statusCode, 401);
    assert.equal(parseBody(sess).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('C12: OTP expired → 401 (SELECT не находит, expires_at < now)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE, expired: true });

    const r = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('C13: после confirm повторный confirm → 409 deletion_already_pending', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });

    // Первый confirm проходит.
    const r1 = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r1.statusCode, 200);

    // Восстанавливаем сессию (имитация нового /auth/verify), чтобы дойти до
    // ветки deletion_already_pending в handler'е, а не получить 401 от requireUser.
    await pool.query(
        `UPDATE private_data.auth_sessions
            SET revoked_at = NULL,
                expires_at = now() + interval '90 days'
          WHERE user_id = $1`,
        [user_id],
    );

    const r2 = await handler(makeEvent({ jwt, body: { otp_code: VALID_OTP_CODE } }), {}, { pool });
    assert.equal(r2.statusCode, 409);
    assert.equal(parseBody(r2).error, 'deletion_already_pending');
    resetTestAuthSecrets();
});
