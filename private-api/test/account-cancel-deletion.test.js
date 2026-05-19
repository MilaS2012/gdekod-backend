// =============================================================================
// account-cancel-deletion.test.js — POST /api/account/cancel-deletion (6.9).
//
// Группа D из спеки. Тройной фильтр (completed/scheduled/grace), race против
// cron, D7 — сценарий «передумать после revoke».
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as cancelHandler } from '../handlers/account/cancel-deletion.js';
import { handler as confirmHandler } from '../handlers/account/delete-confirm.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createDeletionOtp,
    setUserDeletion,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

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
// D — /account/cancel-deletion
// =============================================================================

test('D1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await cancelHandler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('D2: без активного deletion → 409 nothing_to_cancel', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 409);
    assert.equal(parseBody(r).error, 'nothing_to_cancel');
    resetTestAuthSecrets();
});

test('D3: grace period истёк → 410 grace_period_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // scheduled_at в прошлом (положительный offset).
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: 3600 });

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'grace_period_expired');
    resetTestAuthSecrets();
});

test('D4: уже completed → 410 already_deleted', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await setUserDeletion(pool, user_id,
                          { scheduledAtOffsetSeconds: 3600, completed: true });

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 410);
    assert.equal(parseBody(r).error, 'already_deleted');
    resetTestAuthSecrets();
});

test('D5: активный deletion в окне → 200 restored, поля NULL', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // scheduled_at в будущем (отрицательный offset = +3600 в БУДУЩЕМ).
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: -3600 });

    const r = await cancelHandler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).restored, true);

    const u = (await pool.query(
        `SELECT deletion_scheduled_at, deletion_requested_at, deletion_completed_at
           FROM private_data.users WHERE id = $1`,
        [user_id],
    )).rows[0];
    assert.equal(u.deletion_scheduled_at, null);
    assert.equal(u.deletion_requested_at, null);
    assert.equal(u.deletion_completed_at, null);
    resetTestAuthSecrets();
});

test('D6: cancel пишет events_log deletion_cancelled', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await setUserDeletion(pool, user_id, { scheduledAtOffsetSeconds: -3600 });

    await cancelHandler(makeEvent({ jwt }), {}, { pool });
    const { rows } = await pool.query(
        `SELECT event_type FROM private_data.events_log
          WHERE user_id = $1 AND event_type = 'deletion_cancelled'`,
        [user_id],
    );
    assert.equal(rows.length, 1);
    resetTestAuthSecrets();
});

test('D7: «передумать после revoke» — полный сценарий', async () => {
    // 1. Алиса делает delete-confirm с валидным OTP → 200, сессия revoked
    // 2. Тот же JWT больше не работает (cancel → 401)
    // 3. Создаём НОВУЮ сессию (имитация /auth/start + /auth/verify)
    // 4. cancel с новой сессией → 200 restored
    // 5. Старая сессия осталась revoked
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt: oldJwt, session_id: oldSid } = await authedSetup(pool);
    await createDeletionOtp(pool, user_id, { code: VALID_OTP_CODE });

    const confirmResp = await confirmHandler(
        makeEvent({ jwt: oldJwt, body: { otp_code: VALID_OTP_CODE } }),
        {}, { pool },
    );
    assert.equal(confirmResp.statusCode, 200);

    // Старый JWT больше не валиден (сессия revoked).
    const cancelOld = await cancelHandler(makeEvent({ jwt: oldJwt }), {}, { pool });
    assert.equal(cancelOld.statusCode, 401);

    // Имитируем /auth/verify — INSERT новой сессии и подпись JWT.
    const { jwt: newJwt } = await createTestSession(pool, user_id);

    const cancelNew = await cancelHandler(makeEvent({ jwt: newJwt }), {}, { pool });
    assert.equal(cancelNew.statusCode, 200);
    assert.equal(parseBody(cancelNew).restored, true);

    // Старая сессия остаётся revoked.
    const old = (await pool.query(
        `SELECT revoked_at FROM private_data.auth_sessions WHERE session_id = $1`,
        [oldSid],
    )).rows[0];
    assert.ok(old.revoked_at != null, 'старая сессия должна оставаться revoked');

    // deletion_* поля сняты.
    const u = (await pool.query(
        `SELECT deletion_scheduled_at FROM private_data.users WHERE id = $1`,
        [user_id],
    )).rows[0];
    assert.equal(u.deletion_scheduled_at, null);
    resetTestAuthSecrets();
});

test('D8: GET → 405', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await cancelHandler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
