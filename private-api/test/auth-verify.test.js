// =============================================================================
// auth-verify.test.js — handlers/auth/verify.js (POST /api/auth/verify) (6.3.5).
//
// Интеграционные тесты на pg-mem с применёнными миграциями. Каждый тест —
// свежий pool. setTestAuthSecrets() ставит JWT_SECRET и OTP_HMAC_SECRET.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as verifyHandler } from '../handlers/auth/verify.js';
import { verifyJwt } from '../lib/jwt.js';
import { userAgentHash } from '../lib/event.js';
import { requireUser } from '../lib/auth.js';
import {
    newPgMemPool,
    createTestUser,
    createTestOtp,
    setTestAuthSecrets,
    resetTestAuthSecrets,
    eventWithBearer,
} from './helpers.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeEvent({ body, ip = '203.0.113.10', method = 'POST',
                     origin = 'https://gde-code.ru', userAgent = 'Mozilla/5.0 (test)' } = {}) {
    return {
        httpMethod: method,
        headers: {
            origin,
            'user-agent': userAgent,
        },
        requestContext: ip ? { identity: { sourceIp: ip } } : undefined,
        body: body == null ? '' : JSON.stringify(body),
    };
}

function parseBody(res) { return JSON.parse(res.body); }

async function captureLogs(fn) {
    const origLog   = console.log;
    const origWarn  = console.warn;
    const origError = console.error;
    const lines = [];
    const sink = (...args) =>
        lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    console.log = sink; console.warn = sink; console.error = sink;
    let result;
    try { result = await fn(); }
    finally { console.log = origLog; console.warn = origWarn; console.error = origError; }
    return { result, logs: lines.join('\n') };
}

const PHONE = '+79261234567';
const VALID_CODE = '4242';

// =============================================================================
// Группа A — Валидация
// =============================================================================

test('A1: нет body → 400 invalid_input', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: null }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_input');
    resetTestAuthSecrets();
});

test('A2: phone не E.164 → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: { phone: '89261234567', code: '4242' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A3: code пустой → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A4: code не цифры → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '1a2b' } }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A5: code 5 цифр (между 4 и 6) → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r1 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '12345' } }), {}, { pool });
    const r2 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '1' } }), {}, { pool });
    const r3 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '1234567' } }), {}, { pool });
    assert.equal(r1.statusCode, 400);
    assert.equal(r2.statusCode, 400);
    assert.equal(r3.statusCode, 400);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа B — OTP не найден / истёк / used
// =============================================================================

test('B6: phone без активных OTP → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('B7: OTP истёк → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, expired: true });
    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

test('B8: OTP уже used → 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, used: true });
    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа C — Brute-force
// =============================================================================

test('C9: неправильный код → attempts_count++, 401 invalid_or_expired', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    const otp = await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '9999' } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'invalid_or_expired');

    const row = (await pool.query(
        `SELECT attempts_count FROM private_data.otp_codes WHERE id = $1`, [otp.id])).rows[0];
    assert.equal(row.attempts_count, 1);
    resetTestAuthSecrets();
});

test('C10: 5 неправильных подряд → 5-й 401 too_many_attempts, OTP used', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    const otp = await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, attempts: 4 });

    // На 5-й попытке (attempts_count = 4) handler должен сразу вернуть too_many_attempts
    // если attempts >= 5? Нет, 4 < 5 → проверка пройдёт, неверный код → attempts = 5.
    // На СЛЕДУЮЩЕЙ попытке (attempts = 5) → too_many_attempts.
    // Здесь проверяем сценарий: уже 4, неверный код → 5, потом любая попытка → too_many.
    const r1 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '9999' } }), {}, { pool });
    assert.equal(r1.statusCode, 401);
    assert.equal(parseBody(r1).error, 'invalid_or_expired');

    // attempts стал 5
    const after = (await pool.query(
        `SELECT attempts_count FROM private_data.otp_codes WHERE id = $1`, [otp.id])).rows[0];
    assert.equal(after.attempts_count, 5);

    // Следующая попытка — too_many_attempts
    const r2 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r2.statusCode, 401);
    assert.equal(parseBody(r2).error, 'too_many_attempts');

    // OTP помечен used (защёлка)
    const sealed = (await pool.query(
        `SELECT used_at FROM private_data.otp_codes WHERE id = $1`, [otp.id])).rows[0];
    assert.ok(sealed.used_at != null);
    resetTestAuthSecrets();
});

test('C11: после too_many_attempts даже правильный код → 401 (OTP заблокирован)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    const otp = await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, attempts: 5 });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 401);
    assert.equal(parseBody(r).error, 'too_many_attempts');

    // OTP помечен used
    const row = (await pool.query(
        `SELECT used_at FROM private_data.otp_codes WHERE id = $1`, [otp.id])).rows[0];
    assert.ok(row.used_at != null);
    resetTestAuthSecrets();
});

test('C12: attempts=4, правильный код → 200 (последний шанс)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, attempts: 4 });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    assert.ok(typeof parseBody(r).jwt === 'string');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа D — Успех
// =============================================================================

test('D13: правильный код → 200 { jwt }, JWT валидный', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.ok(typeof body.jwt === 'string');
    assert.equal(body.session_id, undefined, 'session_id не должен быть в ответе');

    const payload = await verifyJwt(body.jwt);
    assert.equal(payload.sub, user_id);
    assert.match(payload.sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    resetTestAuthSecrets();
});

test('D14: JWT после verify проходит requireUser', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    const { jwt } = parseBody(r);

    const auth = await requireUser(eventWithBearer(jwt), { pool });
    assert.equal(auth.user_id, user_id);
    resetTestAuthSecrets();
});

test('D15: session создана с TTL ≈ 90 дней', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });

    const session = (await pool.query(
        `SELECT expires_at FROM private_data.auth_sessions LIMIT 1`)).rows[0];
    const ttlSec = Math.round((new Date(session.expires_at).getTime() - Date.now()) / 1000);
    const targetSec = 90 * 24 * 3600;
    assert.ok(Math.abs(ttlSec - targetSec) < 60, `TTL ~90 дней, получено ${ttlSec} сек`);
    resetTestAuthSecrets();
});

test('D16: user_agent_hash в session = SHA-256(UA из headers)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const UA = 'Mozilla/5.0 (X11; Linux x86_64) Custom UA';
    await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE }, userAgent: UA }), {}, { pool });

    const row = (await pool.query(
        `SELECT user_agent_hash FROM private_data.auth_sessions LIMIT 1`)).rows[0];
    assert.equal(row.user_agent_hash, userAgentHash(UA));
    resetTestAuthSecrets();
});

test('D17: ip_address из event сохранён в session', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE }, ip: '198.51.100.42' }), {}, { pool });

    const row = (await pool.query(
        `SELECT ip_address FROM private_data.auth_sessions LIMIT 1`)).rows[0];
    assert.equal(String(row.ip_address), '198.51.100.42');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа E — Логи
// =============================================================================

test('E18: при успехе в лог попадает phone_mask, не полный phone', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const { logs } = await captureLogs(() =>
        verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool }));
    assert.match(logs, /\+7926\*\*\*4567/);
    assert.ok(!logs.includes(PHONE), 'полный phone попал в лог');
    resetTestAuthSecrets();
});

test('E19: при фейле в лог НЕ попадает сам code', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    const WRONG = '8888';
    const { logs } = await captureLogs(() =>
        verifyHandler(makeEvent({ body: { phone: PHONE, code: WRONG } }), {}, { pool }));
    // Сам неверный код в лог не уходит — пишем reason и attempts_remaining.
    assert.ok(!logs.includes(WRONG),     'неверный код попал в лог');
    assert.ok(!logs.includes(VALID_CODE), 'правильный код попал в лог');
    assert.match(logs, /wrong_code/);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа F — Нейтральность ответа
// =============================================================================

test('F20: ответ для "OTP не было", "истёк", "used", "wrong code" — структурно идентичный', async () => {
    setTestAuthSecrets();
    // 4 разных pool'а, 4 разные ситуации, все должны давать одинаковый body.
    const scenarios = [
        async () => { // OTP не существует
            const p = await newPgMemPool();
            await createTestUser(p, PHONE);
            return verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool: p });
        },
        async () => { // OTP истёк
            const p = await newPgMemPool();
            await createTestUser(p, PHONE);
            await createTestOtp(p, { phone: PHONE, code: VALID_CODE, expired: true });
            return verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool: p });
        },
        async () => { // OTP used
            const p = await newPgMemPool();
            await createTestUser(p, PHONE);
            await createTestOtp(p, { phone: PHONE, code: VALID_CODE, used: true });
            return verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool: p });
        },
        async () => { // wrong code
            const p = await newPgMemPool();
            await createTestUser(p, PHONE);
            await createTestOtp(p, { phone: PHONE, code: VALID_CODE });
            return verifyHandler(makeEvent({ body: { phone: PHONE, code: '9999' } }), {}, { pool: p });
        },
    ];
    const results = await Promise.all(scenarios.map(s => s()));
    // statusCode и body.error одинаковые
    const first = parseBody(results[0]);
    for (const r of results) {
        assert.equal(r.statusCode, 401);
        assert.deepEqual(parseBody(r), first);
    }
    resetTestAuthSecrets();
});

test('F21: поле attempts_remaining НЕ в HTTP-ответе (только в логах)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE, attempts: 2 });

    const r = await verifyHandler(makeEvent({ body: { phone: PHONE, code: '9999' } }), {}, { pool });
    const body = parseBody(r);
    assert.equal(body.attempts_remaining, undefined);
    assert.equal(body.remaining,          undefined);
    assert.equal(body.attempts,           undefined);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа G — Race condition (атомарность UPDATE...RETURNING)
// =============================================================================

test('22: параллельные verify с одним кодом → ровно один 200, остальные 401', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    // 5 одновременных запросов
    const promises = Array.from({ length: 5 }, () =>
        verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool }));
    const results = await Promise.all(promises);
    const codes = results.map(r => r.statusCode);
    const successes = codes.filter(c => c === 200).length;
    const failures  = codes.filter(c => c === 401).length;
    assert.equal(successes, 1, `должен быть ровно 1 успех, получено ${successes}: ${codes}`);
    assert.equal(failures,  4, `должно быть 4 фейла, получено ${failures}: ${codes}`);
    resetTestAuthSecrets();
});

// =============================================================================
// Тест 23 — документация поведения при сбое INSERT auth_sessions
// =============================================================================

test('23: если INSERT auth_sessions падает → OTP помечен used, ответ 500, лог содержит причину', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    const otp = await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    // Оборачиваем pool так, чтобы INSERT auth_sessions бросал ошибку.
    const failingPool = {
        query(sql, params) {
            if (typeof sql === 'string' && /INSERT\s+INTO\s+private_data\.auth_sessions/i.test(sql)) {
                return Promise.reject(new Error('simulated network failure on session insert'));
            }
            return pool.query(sql, params);
        },
    };

    const { result: r, logs } = await captureLogs(() =>
        verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {},
            { pool: failingPool }));

    assert.equal(r.statusCode, 500);

    // OTP всё равно помечен used (мы НЕ откатываем — см. шапку handler'а)
    const row = (await pool.query(
        `SELECT used_at FROM private_data.otp_codes WHERE id = $1`, [otp.id])).rows[0];
    assert.ok(row.used_at != null, 'OTP должен остаться used после сбоя session insert');

    // В логе — диагностика
    assert.match(logs, /session_creation_failed/);
    resetTestAuthSecrets();
});

// =============================================================================
// Тест 24 — sequential reuse: повторный verify с тем же кодом отвергается,
// сессия создаётся ровно одна (защита от "сосед увидел код на экране")
// =============================================================================

test('24: sequential reuse — успех → второй verify тем же кодом → 401, сессия одна', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await createTestUser(pool, PHONE);
    await createTestOtp(pool, { phone: PHONE, code: VALID_CODE });

    // Первый вызов — успех
    const r1 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r1.statusCode, 200);
    assert.ok(typeof parseBody(r1).jwt === 'string');

    // Второй вызов с тем же кодом — отказ
    const r2 = await verifyHandler(makeEvent({ body: { phone: PHONE, code: VALID_CODE } }), {}, { pool });
    assert.equal(r2.statusCode, 401);
    assert.equal(parseBody(r2).error, 'invalid_or_expired');

    // В БД должна быть ровно одна сессия (вторая попытка не должна была её создать)
    const sessions = await pool.query(`SELECT count(*)::int AS c FROM private_data.auth_sessions`);
    assert.equal(sessions.rows[0].c, 1, 'должна быть ровно одна auth_session');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень
// =============================================================================

test('OPTIONS → 204 corsPreflight', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: null, method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405 method not allowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(makeEvent({ body: null, method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('тело — не JSON → 400 invalid_input', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await verifyHandler(
        { httpMethod: 'POST', headers: {}, body: '{not_json' },
        {},
        { pool },
    );
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});
