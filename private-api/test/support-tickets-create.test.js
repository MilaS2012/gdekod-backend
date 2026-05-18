// =============================================================================
// support-tickets-create.test.js — POST /api/support/tickets (6.11).
//
// Группа B из спеки 6.11. Валидация, rate-limit (2/час, 5/день),
// snapshot контактных данных (phone обязателен, email только verified).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/support/tickets-create.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestTicket,
    markUserEmailVerified,
    attachUnverifiedEmail,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

const VALID_BODY = {
    category: 'other',
    subject:  'Test subject',
    message:  'message body ≥ 10 chars',
};

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
    const { jwt }            = await createTestSession(pool, user_id);
    return { user_id, phone, jwt };
}

// =============================================================================
// B — /support/tickets POST
// =============================================================================

test('B1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ body: VALID_BODY }), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('B2: валидный input → 201, ticket в БД', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);

    const r = await handler(makeEvent({ jwt, body: VALID_BODY }), {}, { pool });
    assert.equal(r.statusCode, 201);
    const body = parseBody(r);
    assert.ok(typeof body.ticket_id === 'string' && body.ticket_id.length > 0);
    assert.ok(typeof body.created_at === 'string');
    assert.match(body.message, /Обращение создано/);

    // Проверяем, что в БД действительно появился тикет.
    const { rows } = await pool.query(
        `SELECT id, user_id, category, subject, message, status, contact_phone, contact_email
           FROM private_data.support_tickets WHERE id = $1`,
        [body.ticket_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, user_id);
    assert.equal(rows[0].category, 'other');
    assert.equal(rows[0].subject, 'Test subject');
    assert.equal(rows[0].message, 'message body ≥ 10 chars');
    assert.equal(rows[0].status, 'open');
    resetTestAuthSecrets();
});

test('B3: невалидная category → 400 invalid_category', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, body: { ...VALID_BODY, category: 'malformed' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_category');
    resetTestAuthSecrets();
});

test('B4: пустой subject (после trim) → 400 invalid_subject', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, body: { ...VALID_BODY, subject: '   ' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_subject');
    resetTestAuthSecrets();
});

test('B5: слишком длинный subject (>200) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { ...VALID_BODY, subject: 'x'.repeat(201) },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_subject');
    resetTestAuthSecrets();
});

test('B6: слишком короткий message (<10) → 400 invalid_message_length', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { ...VALID_BODY, message: 'short' },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_message_length');
    resetTestAuthSecrets();
});

test('B7: слишком длинный message (>5000) → 400 invalid_message_length', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { ...VALID_BODY, message: 'm'.repeat(5001) },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_message_length');
    resetTestAuthSecrets();
});

test('B8: control chars в subject → 400 invalid_subject', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({
        jwt,
        body: { ...VALID_BODY, subject: 'Test\nNewline' },
    }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_subject');
    resetTestAuthSecrets();
});

test('B9: превышен лимит 2/час → 429 too_many_tickets (window=hour)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // Два тикета свежее часа.
    await createTestTicket(pool, user_id, { createdAtOffsetSeconds: 60 });
    await createTestTicket(pool, user_id, { createdAtOffsetSeconds: 30 });

    const r = await handler(makeEvent({ jwt, body: VALID_BODY }), {}, { pool });
    assert.equal(r.statusCode, 429);
    const body = parseBody(r);
    assert.equal(body.error, 'too_many_tickets');
    assert.equal(body.window, 'hour');
    resetTestAuthSecrets();
});

test('B10: превышен лимит 5/день → 429 too_many_tickets (window=day)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // 5 тикетов в окне суток, но СТАРШЕ часа — чтобы dayLimit сработал
    // раньше hourLimit. createdAtOffsetSeconds > 3600.
    for (let i = 0; i < 5; i++) {
        await createTestTicket(pool, user_id, { createdAtOffsetSeconds: 3700 + i });
    }
    const r = await handler(makeEvent({ jwt, body: VALID_BODY }), {}, { pool });
    assert.equal(r.statusCode, 429);
    const body = parseBody(r);
    assert.equal(body.error, 'too_many_tickets');
    assert.equal(body.window, 'day');
    resetTestAuthSecrets();
});

test('B11: contact_email snapshot — verified email сохранён, unverified → NULL', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // user A — verified email
    const { user_id: uA } = await createTestUser(pool);
    const { jwt: jwtA   } = await createTestSession(pool, uA);
    await markUserEmailVerified(pool, uA, 'verified@example.com');

    // user B — attached, но НЕ verified
    const { user_id: uB } = await createTestUser(pool);
    const { jwt: jwtB   } = await createTestSession(pool, uB);
    await attachUnverifiedEmail(pool, uB, 'pending@example.com');

    const rA = await handler(makeEvent({ jwt: jwtA, body: VALID_BODY }), {}, { pool });
    const rB = await handler(makeEvent({ jwt: jwtB, body: VALID_BODY }), {}, { pool });
    assert.equal(rA.statusCode, 201);
    assert.equal(rB.statusCode, 201);

    const tA = (await pool.query(
        `SELECT contact_email FROM private_data.support_tickets WHERE id = $1`,
        [parseBody(rA).ticket_id],
    )).rows[0];
    const tB = (await pool.query(
        `SELECT contact_email FROM private_data.support_tickets WHERE id = $1`,
        [parseBody(rB).ticket_id],
    )).rows[0];

    assert.equal(tA.contact_email, 'verified@example.com');
    assert.equal(tB.contact_email, null,
                 'unverified email НЕ должен попасть в snapshot — ответ туда не пойдёт');
    resetTestAuthSecrets();
});

test('B12: hint в ответе использует maskEmail, не полный адрес', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const { jwt }     = await createTestSession(pool, user_id);
    await markUserEmailVerified(pool, user_id, 'mila@example.com');

    const r = await handler(makeEvent({ jwt, body: VALID_BODY }), {}, { pool });
    assert.equal(r.statusCode, 201);
    const body = parseBody(r);
    // Маскированный формат m***@e***.com, полный email НЕ выдан.
    assert.ok(!body.message.includes('mila@example.com'),
              `маскированный email обязателен, message=${body.message}`);
    assert.match(body.message, /m\*\*\*@e\*\*\*\.com/);
    resetTestAuthSecrets();
});

test('B13: GET → 405 methodNotAllowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('B14: невалидный JSON в body → 400 invalid_input', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler({
        httpMethod: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
        body: '{not json',
    }, {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_input');
    resetTestAuthSecrets();
});
