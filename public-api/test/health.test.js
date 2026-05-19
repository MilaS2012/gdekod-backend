// =============================================================================
// health.test.js — GET /health для public-api (6.10).
//
// Группа G (public) из спеки.
//
// Дополняет существующие базовые тесты в handlers.test.js (которые проверяют
// 401/500 статус-коды). Эти тесты фокусируются на новых полях:
//   - service: 'public'
//   - version: берётся из GIT_SHA env или 'dev' как fallback
//   - DB-ошибка → 500 (catch-ветка в handler)
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler }                              from '../handlers/health.js';
import { __setPoolForTest, __resetPoolForTest } from '../lib/db.js';

function parseBody(r) { return JSON.parse(r.body); }

const TOKEN = 'test-public-health-token';

// =============================================================================
// G — public health (новые поля)
// =============================================================================

test('G4: правильный Bearer → service=\'public\' и db=true', async () => {
    process.env.PUBLIC_API_HEALTH_TOKEN = TOKEN;
    __setPoolForTest({ async query() { return { rows: [{ ok: 1 }] }; } });

    const r = await handler({
        headers: { authorization: `Bearer ${TOKEN}` },
    }, {});
    assert.equal(r.statusCode, 200);

    const body = parseBody(r);
    assert.equal(body.service, 'public');
    assert.equal(body.db,      true);
    assert.equal(body.status,  'ok');

    __resetPoolForTest();
    delete process.env.PUBLIC_API_HEALTH_TOKEN;
});

test('G5: GIT_SHA не задан → version=\'dev\'', async () => {
    process.env.PUBLIC_API_HEALTH_TOKEN = TOKEN;
    const prevSha = process.env.GIT_SHA;
    delete process.env.GIT_SHA;
    __setPoolForTest({ async query() { return { rows: [{ ok: 1 }] }; } });

    const r = await handler({
        headers: { authorization: `Bearer ${TOKEN}` },
    }, {});
    const body = parseBody(r);
    assert.equal(body.version, 'dev');

    __resetPoolForTest();
    delete process.env.PUBLIC_API_HEALTH_TOKEN;
    if (prevSha !== undefined) process.env.GIT_SHA = prevSha;
});

test('G6: DB throws → 500 (catch-ветка handler\'а)', async () => {
    process.env.PUBLIC_API_HEALTH_TOKEN = TOKEN;
    __setPoolForTest({ async query() { throw new Error('db down'); } });

    const r = await handler({
        headers: { authorization: `Bearer ${TOKEN}` },
    }, {});
    assert.equal(r.statusCode, 500);

    __resetPoolForTest();
    delete process.env.PUBLIC_API_HEALTH_TOKEN;
});
