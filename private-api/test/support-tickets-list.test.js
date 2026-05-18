// =============================================================================
// support-tickets-list.test.js — GET /api/support/tickets (6.11).
//
// Группа A из спеки 6.11. message/contact_phone/contact_email НЕ в выдаче
// (для UI достаточно subject + status). 'spam'-тикеты не показываются user.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/support/tickets-list.js';
import {
    newPgMemPool,
    createTestUser,
    createTestSession,
    createTestTicket,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

function makeEvent({ jwt = null, query = null, method = 'GET' } = {}) {
    return {
        httpMethod: method,
        headers: { origin: 'https://gde-code.ru',
                   ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        queryStringParameters: query,
    };
}
function parseBody(res) { return JSON.parse(res.body); }

async function authedSetup(pool) {
    const { user_id } = await createTestUser(pool);
    const { jwt }     = await createTestSession(pool, user_id);
    return { user_id, jwt };
}

// =============================================================================
// A — /support/tickets GET
// =============================================================================

test('A1: без JWT → 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({}), {}, { pool });
    assert.equal(r.statusCode, 401);
    resetTestAuthSecrets();
});

test('A2: пустая история → items=[], total=0', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    resetTestAuthSecrets();
});

test('A3: с 3 тикетами → возвращаются по created_at DESC', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    // Создаём в обратном порядке времени: t1 — самый старый, t3 — самый свежий
    await createTestTicket(pool, user_id, { subject: 't1', createdAtOffsetSeconds: 300 });
    await createTestTicket(pool, user_id, { subject: 't2', createdAtOffsetSeconds: 200 });
    await createTestTicket(pool, user_id, { subject: 't3', createdAtOffsetSeconds: 100 });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.total, 3);
    assert.equal(body.items.length, 3);
    // Свежие сверху.
    assert.deepEqual(body.items.map(t => t.subject), ['t3', 't2', 't1']);
    // Контент-поля не утекают в list.
    assert.equal(body.items[0].message, undefined);
    assert.equal(body.items[0].contact_phone, undefined);
    assert.equal(body.items[0].contact_email, undefined);
    resetTestAuthSecrets();
});

test('A4: status=open фильтр — только открытые', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestTicket(pool, user_id, { subject: 'open-1',     status: 'open',
                                            createdAtOffsetSeconds: 100 });
    await createTestTicket(pool, user_id, { subject: 'closed-1',   status: 'closed',
                                            createdAtOffsetSeconds: 200 });
    await createTestTicket(pool, user_id, { subject: 'progress-1', status: 'in_progress',
                                            createdAtOffsetSeconds: 300 });

    const r = await handler(makeEvent({ jwt, query: { status: 'open' } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].subject, 'open-1');
    resetTestAuthSecrets();
});

test('A5: status=all (default) — все, кроме spam', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id, jwt } = await authedSetup(pool);
    await createTestTicket(pool, user_id, { subject: 'open',   status: 'open',     createdAtOffsetSeconds: 100 });
    await createTestTicket(pool, user_id, { subject: 'closed', status: 'closed',   createdAtOffsetSeconds: 200 });
    await createTestTicket(pool, user_id, { subject: 'spam',   status: 'spam',     createdAtOffsetSeconds: 300 });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.total, 2);
    assert.deepEqual(body.items.map(t => t.subject).sort(), ['closed', 'open']);
    // spam НЕ показан user — даже при status=all.
    assert.equal(body.items.find(t => t.status === 'spam'), undefined);
    resetTestAuthSecrets();
});

test('A6: тикеты другого user не возвращаются (изоляция)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id: u1, jwt } = await authedSetup(pool);
    const { user_id: u2 } = await createTestUser(pool);

    await createTestTicket(pool, u1, { subject: 'mine'    });
    await createTestTicket(pool, u2, { subject: 'foreign' });

    const r = await handler(makeEvent({ jwt }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].subject, 'mine');
    resetTestAuthSecrets();
});

test('A7: невалидный status в query → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    // 'spam' специально — нельзя запросить ?status=spam.
    const r = await handler(makeEvent({ jwt, query: { status: 'spam' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_status');
    resetTestAuthSecrets();
});

test('A8: невалидный limit (>50) → 400 invalid_pagination', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { jwt } = await authedSetup(pool);
    const r = await handler(makeEvent({ jwt, query: { limit: '999' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_pagination');
    resetTestAuthSecrets();
});

test('A9: OPTIONS → 204 corsPreflight', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('A10: POST → 405 methodNotAllowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ method: 'POST' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});
