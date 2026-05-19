// =============================================================================
// health.test.js — GET /health для private-api (6.10).
//
// Группа G (private) из спеки.
//
// Эндпоинт Bearer-protected: без PRIVATE_API_HEALTH_TOKEN в env → 500
// (намеренно — чтобы health не стал случайно публичным).
// Правильный Bearer + working DB → 200 {status, service, version, db, time}.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler }                              from '../handlers/health.js';
import { __setPoolForTest, __resetPoolForTest } from '../lib/db.js';

function parseBody(r) { return JSON.parse(r.body); }

function withBearer(token) {
    return { headers: { authorization: `Bearer ${token}` } };
}

const TOKEN = 'test-private-health-token';

// =============================================================================
// G — private health
// =============================================================================

test('G1: PRIVATE_API_HEALTH_TOKEN не задан → 500 (endpoint заблокирован)', async () => {
    const prev = process.env.PRIVATE_API_HEALTH_TOKEN;
    delete process.env.PRIVATE_API_HEALTH_TOKEN;

    const r = await handler(withBearer('any'), {});
    assert.equal(r.statusCode, 500);

    if (prev !== undefined) process.env.PRIVATE_API_HEALTH_TOKEN = prev;
});

test('G2: токен задан, неверный Bearer → 401', async () => {
    process.env.PRIVATE_API_HEALTH_TOKEN = TOKEN;

    const r = await handler(withBearer('wrong-token'), {});
    assert.equal(r.statusCode, 401);

    delete process.env.PRIVATE_API_HEALTH_TOKEN;
});

test('G3: правильный Bearer → 200, service=\'private\', version из GIT_SHA или \'dev\'', async () => {
    process.env.PRIVATE_API_HEALTH_TOKEN = TOKEN;
    const gitSha = 'abc1234deadbeef';
    process.env.GIT_SHA = gitSha;
    __setPoolForTest({ async query() { return { rows: [{ ok: 1 }] }; } });

    const r = await handler(withBearer(TOKEN), {});
    assert.equal(r.statusCode, 200);

    const body = parseBody(r);
    assert.equal(body.status,   'ok');
    assert.equal(body.service,  'private');
    assert.equal(body.version,  gitSha);
    assert.equal(body.db,       true);
    assert.ok(typeof body.time === 'string', 'time должно быть ISO-строкой');

    __resetPoolForTest();
    delete process.env.PRIVATE_API_HEALTH_TOKEN;
    delete process.env.GIT_SHA;
});
