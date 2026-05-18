// =============================================================================
// auth-start.test.js — handlers/auth/start.js (POST /api/auth/start) (6.3.4).
//
// Интеграционные тесты: pg-mem с применёнными миграциями + проверка
// поведения handler'а end-to-end (без сети).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../handlers/auth/start.js';
import { hashOtpCode } from '../lib/otp.js';
import {
    newPgMemPool,
    createTestUser,
    insertUsedOtp,
    markUserEmailVerified,
    attachUnverifiedEmail,
    setTestAuthSecrets,
    resetTestAuthSecrets,
} from './helpers.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeEvent(body, { ip = '203.0.113.10', method = 'POST', origin = 'https://gde-code.ru' } = {}) {
    return {
        httpMethod: method,
        headers: { origin },
        requestContext: { identity: { sourceIp: ip } },
        body: body == null ? '' : JSON.stringify(body),
    };
}

function parseBody(res) { return JSON.parse(res.body); }

async function captureLogs(fn) {
    const origLog   = console.log;
    const origError = console.error;
    const lines = [];
    const sink = (...args) =>
        lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    console.log = sink;
    console.error = sink;
    let result;
    try { result = await fn(); }
    finally { console.log = origLog; console.error = origError; }
    return { result, logs: lines.join('\n') };
}

// =============================================================================
// Группа A — Валидация
// =============================================================================

test('A1: нет body → 400 invalid_phone', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent(null), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_phone');
    resetTestAuthSecrets();
});

test('A2: phone не E.164 → 400 invalid_phone', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ phone: '89261234567' }), {}, { pool });
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_phone');
    resetTestAuthSecrets();
});

test('A3: phone слишком короткий → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ phone: '+1234' }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

test('A4: phone слишком длинный → 400', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent({ phone: '+1234567890123456' }), {}, { pool });
    assert.equal(r.statusCode, 400);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа B — Rate-limit
// =============================================================================

test('B5: повторный запрос на тот же phone в течение 30 сек → 429 cooldown', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const phone = '+79261111111';
    // Имитируем недавний OTP — 30 сек назад.
    await insertUsedOtp(pool, { phone, createdAtOffsetSeconds: 30 });

    const r = await handler(makeEvent({ phone }), {}, { pool });
    assert.equal(r.statusCode, 429);
    assert.equal(parseBody(r).error, 'rate_limited');
    assert.ok(r.headers['Retry-After']);
    resetTestAuthSecrets();
});

test('B6: 20 OTP с одного IP на разные номера → 21-й (новый номер) → 429 daily_limit_ip', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const IP = '203.0.113.1';
    for (let i = 0; i < 20; i++) {
        await insertUsedOtp(pool, {
            phone: `+7926${String(i).padStart(7, '0')}`,
            ip:    IP,
            createdAtOffsetSeconds: 120 + i * 30,
        });
    }
    const r = await handler(
        makeEvent({ phone: '+79264444444' }, { ip: IP }),
        {},
        { pool },
    );
    assert.equal(r.statusCode, 429);
    resetTestAuthSecrets();
});

test('B7: 5 OTP на один phone за сутки → 6-й → 429 daily_limit_phone', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const phone = '+79261111111';
    for (let i = 0; i < 5; i++) {
        await insertUsedOtp(pool, { phone, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const r = await handler(makeEvent({ phone }), {}, { pool });
    assert.equal(r.statusCode, 429);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа C — Новый пользователь
// =============================================================================

test('C8: новый phone → user создаётся, channel=sms (юридическое требование подписки), 200', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const phone = '+79261111111';

    const { result: r } = await captureLogs(() => handler(makeEvent({ phone }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.channel, 'sms');
    assert.equal(body.hint,    'check_sms_for_subscription_terms');

    // user создан
    const u = await pool.query(
        `SELECT id FROM private_data.users WHERE phone = '+79261111111'`,
    );
    assert.equal(u.rows.length, 1);
    resetTestAuthSecrets();
});

test('C9: новый phone → otp_code создан с channel=sms (6 цифр) и 64-hex code_hash', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    await captureLogs(() => handler(makeEvent({ phone: '+79261111111' }), {}, { pool }));

    const rows = await pool.query(
        `SELECT channel, code_hash FROM private_data.otp_codes`,
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].channel, 'sms');
    assert.match(rows.rows[0].code_hash, /^[0-9a-f]{64}$/);
    resetTestAuthSecrets();
});

test('C10: новый phone → sms-provider mock вызван (лог содержит маскированный номер)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { logs } = await captureLogs(() => handler(makeEvent({ phone: '+79261234567' }), {}, { pool }));
    // sms-provider mock пишет: '[sms mock] OTP sent { phone: '+7926***4567', ... }'
    assert.match(logs, /\[sms mock\]/);
    assert.match(logs, /\+7926\*\*\*4567/);
    assert.ok(!logs.includes('+79261234567'), 'полный phone попал в лог');
    resetTestAuthSecrets();
});

// =============================================================================
// Группа D — Существующий пользователь без email
// =============================================================================

test('D11: phone в БД, email IS NULL → channel=flash_call, OTP отправлен', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, '+79261111111');

    const { result: r } = await captureLogs(() =>
        handler(makeEvent({ phone: '+79261111111' }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).channel, 'flash_call');

    // Никаких magic-link токенов
    const ml = await pool.query(`SELECT count(*)::int AS c FROM private_data.magic_link_tokens`);
    assert.equal(ml.rows[0].c, 0);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа E — Существующий с verified email → magic link
// =============================================================================

test('E12: phone в БД, email_verified_at NOT NULL → channel=magic_link, email-provider вызван', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, '+79261111111');
    await markUserEmailVerified(pool, user_id, 'user@example.com');

    const { result: r, logs } = await captureLogs(() =>
        handler(makeEvent({ phone: '+79261111111' }), {}, { pool }));
    assert.equal(r.statusCode, 200);
    assert.equal(parseBody(r).channel, 'magic_link');
    assert.equal(parseBody(r).hint,    'check_your_email');

    // email-mock пишет про маскированный адрес
    assert.match(logs, /\[email mock\]/);
    assert.match(logs, /u\*\*\*@e\*\*\*\.com/);
    assert.ok(!logs.includes('user@example.com'), 'полный email попал в лог');

    // Никаких OTP-кодов — magic-link branch их не создаёт
    const otps = await pool.query(`SELECT count(*)::int AS c FROM private_data.otp_codes`);
    assert.equal(otps.rows[0].c, 0);
    resetTestAuthSecrets();
});

test('E13: magic_link_token создан с TTL ≈ 30 минут, привязан к user_id', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, '+79261111111');
    await markUserEmailVerified(pool, user_id, 'user@example.com');

    await captureLogs(() => handler(makeEvent({ phone: '+79261111111' }), {}, { pool }));

    const rows = await pool.query(
        `SELECT token, user_id, expires_at, used_at, ip_address
           FROM private_data.magic_link_tokens`,
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.equal(row.user_id, user_id);
    assert.equal(row.used_at, null);
    assert.match(row.token, /^[A-Za-z0-9_-]{43}$/);

    const expiresMs = new Date(row.expires_at).getTime();
    const ttlSec = Math.round((expiresMs - Date.now()) / 1000);
    assert.ok(ttlSec >= 29 * 60 && ttlSec <= 31 * 60, `TTL должен быть ~30 минут, получено ${ttlSec} сек`);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа F — Email привязан, но НЕ verified
// =============================================================================

test('F14: phone в БД, email NOT NULL, email_verified_at IS NULL → channel=flash_call (email не используется)', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, '+79261111111');
    await attachUnverifiedEmail(pool, user_id, 'pending@example.com');

    const { result: r } = await captureLogs(() =>
        handler(makeEvent({ phone: '+79261111111' }), {}, { pool }));
    assert.equal(parseBody(r).channel, 'flash_call');

    // magic_link_tokens не создавались
    const ml = await pool.query(`SELECT count(*)::int AS c FROM private_data.magic_link_tokens`);
    assert.equal(ml.rows[0].c, 0);
    resetTestAuthSecrets();
});

// =============================================================================
// Группа G — логи без полного PII
// =============================================================================

test('G15: в логе только маскированный phone, IP и email — никогда полные', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool, '+79261234567');
    await markUserEmailVerified(pool, user_id, 'someone@example.com');

    const { logs } = await captureLogs(() =>
        handler(makeEvent({ phone: '+79261234567' }, { ip: '198.51.100.42' }), {}, { pool }));

    // Маскированные присутствуют
    assert.match(logs, /\+7926\*\*\*4567/);
    assert.match(logs, /198\.51\.x\.x/);
    assert.match(logs, /s\*\*\*@e\*\*\*\.com/);

    // Полные — нигде
    assert.ok(!logs.includes('+79261234567'),    'полный phone в логе');
    assert.ok(!logs.includes('198.51.100.42'),   'полный IP в логе');
    assert.ok(!logs.includes('someone@example.com'), 'полный email в логе');
    resetTestAuthSecrets();
});

// =============================================================================
// HTTP-уровень — methodNotAllowed / OPTIONS / invalid_json
// =============================================================================

test('OPTIONS → 204 corsPreflight', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent(null, { method: 'OPTIONS' }), {}, { pool });
    assert.equal(r.statusCode, 204);
    resetTestAuthSecrets();
});

test('GET → 405 method not allowed', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(makeEvent(null, { method: 'GET' }), {}, { pool });
    assert.equal(r.statusCode, 405);
    resetTestAuthSecrets();
});

test('тело — не JSON → 400 invalid_json', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const r = await handler(
        { httpMethod: 'POST', headers: {}, body: '{not_json' },
        {},
        { pool },
    );
    assert.equal(r.statusCode, 400);
    assert.equal(parseBody(r).error, 'invalid_json');
    resetTestAuthSecrets();
});

// =============================================================================
// X-Forwarded-For — fallback извлечения IP, когда нет requestContext.identity
// =============================================================================

test('T1: нет sourceIp + есть X-Forwarded-For → IP = первый адрес из XFF', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    // 20 OTP с IP 203.0.113.5 на разных номерах — заполняем daily-limit_ip.
    for (let i = 0; i < 20; i++) {
        await insertUsedOtp(pool, {
            phone: `+7926${String(i).padStart(7, '0')}`,
            ip: '203.0.113.5',
            createdAtOffsetSeconds: 120 + i * 30,
        });
    }
    // Запрос на новый phone, без sourceIp, но с X-Forwarded-For где
    // первый адрес — '203.0.113.5' (реальный клиент), остальные — прокси.
    const event = {
        httpMethod: 'POST',
        headers: {
            origin: 'https://gde-code.ru',
            'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.16.0.1',
        },
        body: JSON.stringify({ phone: '+79264444444' }),
        // requestContext отсутствует
    };
    const r = await handler(event, {}, { pool });
    // Если IP правильно извлечён из XFF (первый), сработает daily_limit_ip.
    assert.equal(r.statusCode, 429, `должен быть rate-limit, статус=${r.statusCode}`);
    resetTestAuthSecrets();
});

test('T2: нет sourceIp И нет X-Forwarded-For → ip=null, запрос обрабатывается без IP-rate-limit', async () => {
    setTestAuthSecrets();
    const pool = await newPgMemPool();
    const event = {
        httpMethod: 'POST',
        headers: { origin: 'https://gde-code.ru' },
        body: JSON.stringify({ phone: '+79264444444' }),
    };
    const { result: r, logs } = await captureLogs(() => handler(event, {}, { pool }));
    assert.equal(r.statusCode, 200, `должен пройти, статус=${r.statusCode}`);
    // Новый user → channel='sms' (юридическое требование подписки).
    assert.equal(parseBody(r).channel, 'sms');
    // В логе ip_mask должен быть '***' (нет IP)
    assert.match(logs, /"ip_mask":"\*\*\*"/);
    resetTestAuthSecrets();
});

// =============================================================================
// Проверка, что HTTP-ответ не выдаёт существование/несуществование user
// =============================================================================

// =============================================================================
// C-new — Логика выбора channel для трёх состояний user
// =============================================================================
// ⚠️ Раньше тут был тест "ответ структурно идентичен для нового/существующего"
// (защита от enumeration). После введения SMS-канала для новых user'ов
// (юридическое требование рекуррентной подписки) channel ОТЛИЧАЕТСЯ:
//   - новый user           → 'sms'
//   - existing без email   → 'flash_call'
//   - existing + verified  → 'magic_link'
// Это сознательная жертва anti-enumeration защиты ради юридической чистоты
// при оформлении подписки. Документируется этим тестом.

test('C-new: выбор канала для трёх состояний user (sms / flash_call / magic_link)', async () => {
    setTestAuthSecrets();

    // (1) Новый user → channel='sms', 6 цифр
    const poolNew = await newPgMemPool();
    const rNew = await captureLogs(() => handler(makeEvent({ phone: '+79261111111' }), {}, { pool: poolNew }));
    assert.equal(parseBody(rNew.result).channel, 'sms');
    assert.equal(parseBody(rNew.result).hint,    'check_sms_for_subscription_terms');
    const otpNew = await poolNew.query(`SELECT channel FROM private_data.otp_codes`);
    assert.equal(otpNew.rows[0].channel, 'sms');
    assert.match(otpNew.rows[0].channel, /^sms$/); // sanity

    // (2) Existing user без email → channel='flash_call', 4 цифры
    const poolExisting = await newPgMemPool();
    await createTestUser(poolExisting, '+79262222222');
    const rExisting = await captureLogs(() => handler(makeEvent({ phone: '+79262222222' }), {}, { pool: poolExisting }));
    assert.equal(parseBody(rExisting.result).channel, 'flash_call');
    assert.equal(parseBody(rExisting.result).hint,    'enter_last_4_digits_of_incoming_call');
    const otpExisting = await poolExisting.query(`SELECT channel FROM private_data.otp_codes`);
    assert.equal(otpExisting.rows[0].channel, 'flash_call');

    // (3) Existing user с verified email → channel='magic_link', никакого OTP
    const poolVerified = await newPgMemPool();
    const { user_id: vId } = await createTestUser(poolVerified, '+79263333333');
    const { markUserEmailVerified } = await import('./helpers.js');
    await markUserEmailVerified(poolVerified, vId, 'verified@example.com');
    const rVerified = await captureLogs(() => handler(makeEvent({ phone: '+79263333333' }), {}, { pool: poolVerified }));
    assert.equal(parseBody(rVerified.result).channel, 'magic_link');
    assert.equal(parseBody(rVerified.result).hint,    'check_your_email');
    const otpVerified = await poolVerified.query(`SELECT count(*)::int AS c FROM private_data.otp_codes`);
    assert.equal(otpVerified.rows[0].c, 0, 'для magic_link ветки OTP не создаётся');
    const mlVerified = await poolVerified.query(`SELECT count(*)::int AS c FROM private_data.magic_link_tokens`);
    assert.equal(mlVerified.rows[0].c, 1);

    resetTestAuthSecrets();
});
