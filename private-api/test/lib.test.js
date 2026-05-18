// =============================================================================
// lib.test.js — юнит-тесты каркаса приватного API (этап 6.1).
//
// Используем встроенный node:test (Node 20+). Никаких сторонних деп.
// PG-pool подменяется через __setPoolForTest, чтобы тесты не открывали
// реальных коннектов.
//
// На 6.1 закрываем: cors, response, mask-pii, sms-provider mock,
// email-provider mock, health handler. JWT и реальный auth — этап 6.3.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { __setPoolForTest, __resetPoolForTest } from '../lib/db.js';
import { isAllowedOrigin, corsHeaders } from '../lib/cors.js';
import {
    ok, badRequest, unauthorized, forbidden, notFound,
    methodNotAllowed, conflict, gone, tooManyRequests, serverError,
    corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../lib/response.js';
import { maskPhone, maskEmail, maskToken, maskIp } from '../lib/mask-pii.js';
import { sendOtpSms } from '../lib/sms-provider.js';
import { sendEmailVerify, sendMagicLink } from '../lib/email-provider.js';
import { extractBearerToken } from '../lib/auth.js';
// requireUser — полные тесты в test/auth.test.js (6.3.2)
// lib/jwt.js — отдельный test/jwt.test.js (полная реализация в 6.3.1).

import { handler as healthHandler } from '../handlers/health.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseBody(res) { return JSON.parse(res.body); }

function withOrigin(event = {}, origin = 'https://gde-code.ru') {
    return { ...event, headers: { ...(event.headers || {}), origin } };
}

/**
 * Перехватывает console.log и console.error на время функции `fn`.
 * Возвращает массив всех строк, которые попали в лог (JSON-сериализованных
 * для объектов). Нужен для тестов на «нет PII в логах».
 */
async function captureLogs(fn) {
    const origLog = console.log;
    const origErr = console.error;
    const lines = [];
    const sink = (...args) => {
        lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.log = sink;
    console.error = sink;
    try { await fn(); }
    finally {
        console.log = origLog;
        console.error = origErr;
    }
    return lines;
}

// -----------------------------------------------------------------------------
// lib/cors.js
// -----------------------------------------------------------------------------

test('cors: gde-code.ru и www — разрешены', () => {
    assert.equal(isAllowedOrigin('https://gde-code.ru'),     true);
    assert.equal(isAllowedOrigin('https://www.gde-code.ru'), true);
});

test('cors: чужой origin → fallback на gde-code.ru, Vary включает Origin', () => {
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);
    const h = corsHeaders('https://evil.example.com');
    assert.equal(h['Access-Control-Allow-Origin'], 'https://gde-code.ru');
    assert.match(h['Vary'], /Origin/);
});

test('cors: методы включают POST/PATCH/DELETE (не только GET)', () => {
    const h = corsHeaders('https://gde-code.ru');
    assert.match(h['Access-Control-Allow-Methods'], /POST/);
    assert.match(h['Access-Control-Allow-Methods'], /PATCH/);
    assert.match(h['Access-Control-Allow-Methods'], /DELETE/);
    assert.match(h['Access-Control-Allow-Methods'], /OPTIONS/);
});

test('cors: Authorization в разрешённых заголовках, credentials=true', () => {
    const h = corsHeaders('https://gde-code.ru');
    assert.match(h['Access-Control-Allow-Headers'], /Authorization/);
    assert.equal(h['Access-Control-Allow-Credentials'], 'true');
});

test('cors: null/undefined origin → fallback без падения', () => {
    assert.equal(isAllowedOrigin(null),      false);
    assert.equal(isAllowedOrigin(undefined), false);
    assert.equal(isAllowedOrigin(123),       false);
});

// -----------------------------------------------------------------------------
// lib/response.js
// -----------------------------------------------------------------------------

test('response: ok → 200, JSON, CORS-заголовки', () => {
    const r = ok({ a: 1 }, { origin: 'https://gde-code.ru' });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['Content-Type'], /application\/json/);
    assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://gde-code.ru');
    assert.deepEqual(parseBody(r), { a: 1 });
});

test('response: статусы 400/401/403/404/409/410/500', () => {
    assert.equal(badRequest('bad').statusCode,    400);
    assert.equal(unauthorized().statusCode,       401);
    assert.equal(forbidden().statusCode,          403);
    assert.equal(notFound().statusCode,           404);
    assert.equal(conflict('dup').statusCode,      409);
    assert.equal(gone('expired').statusCode,      410);
    assert.equal(serverError().statusCode,        500);
});

test('response: conflict принимает объект { error, message }', () => {
    const r = conflict({ error: 'foo', message: 'human-readable' });
    assert.equal(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.equal(body.error,   'foo');
    assert.equal(body.message, 'human-readable');
});

test('response: 405 — Allow-заголовок собирается из массива', () => {
    const r = methodNotAllowed(['GET', 'POST']);
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers['Allow'], 'GET, POST');
});

test('response: 429 — Retry-After в заголовке и теле', () => {
    const r = tooManyRequests('Slow down', { retryAfterSeconds: 60 });
    assert.equal(r.statusCode, 429);
    assert.equal(r.headers['Retry-After'], '60');
    assert.equal(parseBody(r).retry_after_seconds, 60);
});

test('response: 429 без retryAfter — нет заголовка Retry-After', () => {
    const r = tooManyRequests('Slow down');
    assert.equal(r.statusCode, 429);
    assert.equal(r.headers['Retry-After'], undefined);
    assert.equal(parseBody(r).retry_after_seconds, null);
});

test('response: corsPreflight → 204 без тела', () => {
    const r = corsPreflight('https://gde-code.ru');
    assert.equal(r.statusCode, 204);
    assert.equal(r.body, '');
    assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://gde-code.ru');
});

test('response: parseJsonBody — null/строка/объект/невалидный JSON', () => {
    assert.deepEqual(parseJsonBody({ body: '' }),        {});
    assert.deepEqual(parseJsonBody({ body: null }),       {});
    assert.deepEqual(parseJsonBody({ body: '{"a":1}' }),  { a: 1 });
    assert.deepEqual(parseJsonBody({ body: { a: 1 } }),   { a: 1 });
    assert.equal(   parseJsonBody({ body: '{не_json' }), null);
});

test('response: getOrigin — case-insensitive', () => {
    assert.equal(getOrigin({ headers: { origin: 'a' } }), 'a');
    assert.equal(getOrigin({ headers: { Origin: 'b' } }), 'b');
    assert.equal(getOrigin({ headers: {} }), null);
    assert.equal(getOrigin({}), null);
});

test('response: toIso — Date/строка/null', () => {
    const d = new Date('2026-01-01T12:00:00Z');
    assert.equal(toIso(d), '2026-01-01T12:00:00.000Z');
    assert.equal(toIso('already-iso'), 'already-iso');
    assert.equal(toIso(null), null);
    assert.equal(toIso(undefined), null);
});

// -----------------------------------------------------------------------------
// lib/mask-pii.js
// -----------------------------------------------------------------------------

test('mask-pii: maskPhone — последние 4 цифры, код страны', () => {
    assert.equal(maskPhone('+79261234567'),  '+7926***4567');
    assert.equal(maskPhone('89261234567'),   '+8926***4567');
});

test('mask-pii: maskPhone — невалидное → ***', () => {
    assert.equal(maskPhone(''),          '***');
    assert.equal(maskPhone(null),        '***');
    assert.equal(maskPhone(undefined),   '***');
    assert.equal(maskPhone(12345),       '***');
    assert.equal(maskPhone('+7926'),     '***'); // < 7 цифр
});

test('mask-pii: maskEmail — первая буква локали и домена, TLD сохранён', () => {
    assert.equal(maskEmail('user@example.com'), 'u***@e***.com');
    assert.equal(maskEmail('a@b.co'),           'a***@b***.co');
    assert.equal(maskEmail('foo.bar@sub.ya.ru'), 'f***@s***.ru');
});

test('mask-pii: maskEmail — невалидное → ***', () => {
    assert.equal(maskEmail(''),         '***');
    assert.equal(maskEmail('no-at'),    '***');
    assert.equal(maskEmail('@nolocal'), '***');
    assert.equal(maskEmail('a@b'),      '***'); // нет точки
    assert.equal(maskEmail('a@b.'),     '***'); // TLD пустой
    assert.equal(maskEmail(null),       '***');
});

test('mask-pii: maskToken — head...tail для длинных, *** для коротких', () => {
    assert.equal(maskToken('abcdef1234567890'), 'abcd...7890');
    assert.equal(maskToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature'),
                 'eyJh...ture');
    assert.equal(maskToken('short'),  '***');
    assert.equal(maskToken(''),       '***');
    assert.equal(maskToken(null),     '***');
});

test('mask-pii: maskIp — IPv4 показывает первые 2 октета', () => {
    assert.equal(maskIp('192.168.1.42'), '192.168.x.x');
    assert.equal(maskIp('10.0.0.1'),     '10.0.x.x');
});

test('mask-pii: maskIp — IPv6 показывает первые 2 группы', () => {
    assert.equal(maskIp('2001:db8::1'),         '2001:db8:...');
    assert.equal(maskIp('fe80::1ff:fe23:4567'), 'fe80::...');
});

test('mask-pii: maskIp — невалидное → ***', () => {
    assert.equal(maskIp(''),             '***');
    assert.equal(maskIp(null),           '***');
    assert.equal(maskIp(undefined),      '***');
    assert.equal(maskIp(123),            '***');
    assert.equal(maskIp('not-an-ip'),    '***');
    assert.equal(maskIp('1.2.3'),        '***'); // не 4 октета
});

// -----------------------------------------------------------------------------
// lib/sms-provider.js (мок)
// -----------------------------------------------------------------------------

test('sms-provider: мок не пишет код в лог', async () => {
    const phone = '+79261234567';
    const code  = '654321';
    delete process.env.SMS_RU_API_ID;

    let result;
    const logs = await captureLogs(async () => {
        result = await sendOtpSms({ phone, code });
    });

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'mock');
    assert.match(result.externalId, /^[0-9a-f-]{36}$/);

    const combined = logs.join('\n');
    assert.ok(!combined.includes(code),         `код "${code}" попал в лог: ${combined}`);
    assert.ok(!combined.includes(phone),        `номер "${phone}" попал в лог: ${combined}`);
    assert.ok(combined.includes('+7926***4567'), `замаскированный номер не найден: ${combined}`);
});

test('sms-provider: валидация phone и code', async () => {
    delete process.env.SMS_RU_API_ID;
    await assert.rejects(sendOtpSms({ phone: '79261234567', code: '123456' }), /E\.164/);
    await assert.rejects(sendOtpSms({ phone: '+79261234567', code: 'abc' }),   /digits/);
    await assert.rejects(sendOtpSms({ phone: '+79261234567', code: '12' }),    /digits/);
});

// -----------------------------------------------------------------------------
// lib/email-provider.js (мок)
// -----------------------------------------------------------------------------

test('email-provider: sendEmailVerify мок не пишет email и токен в лог', async () => {
    const to = 'someone@example.com';
    const token = 'secret-token-abcdef-1234567890';
    const link = `https://gde-code.ru/auth/email/verify?token=${token}`;
    delete process.env.YANDEX_POSTBOX_SMTP_HOST;

    let result;
    const logs = await captureLogs(async () => {
        result = await sendEmailVerify({ to, link });
    });

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'mock');

    const combined = logs.join('\n');
    assert.ok(!combined.includes(to),    `email "${to}" попал в лог: ${combined}`);
    assert.ok(!combined.includes(token), `token попал в лог: ${combined}`);
    assert.ok(combined.includes('s***@e***.com'), `замаскированный email не найден: ${combined}`);
});

test('email-provider: sendMagicLink требует phoneMask', async () => {
    delete process.env.YANDEX_POSTBOX_SMTP_HOST;
    await assert.rejects(
        sendMagicLink({ to: 'u@e.com', link: 'https://gde-code.ru/x' }),
        /phoneMask required/
    );
    const r = await sendMagicLink({
        to: 'u@e.com',
        link: 'https://gde-code.ru/x',
        phoneMask: '+7926***4567',
    });
    assert.equal(r.ok, true);
});

test('email-provider: валидация email и https-линка', async () => {
    delete process.env.YANDEX_POSTBOX_SMTP_HOST;
    await assert.rejects(sendEmailVerify({ to: 'no-at', link: 'https://x' }), /invalid email/);
    await assert.rejects(sendEmailVerify({ to: 'u@e.com', link: 'http://x' }), /https:/);
});

// -----------------------------------------------------------------------------
// lib/auth.js
// -----------------------------------------------------------------------------

test('auth: extractBearerToken — case-insensitive header, парсит "Bearer X"', () => {
    assert.equal(extractBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
    assert.equal(extractBearerToken({ headers: { Authorization: 'Bearer abc' } }), 'abc');
    assert.equal(extractBearerToken({ headers: { authorization: 'bearer abc' } }), null); // case-sensitive scheme
    assert.equal(extractBearerToken({ headers: { authorization: 'Basic abc' } }),  null);
    assert.equal(extractBearerToken({ headers: {} }), null);
    assert.equal(extractBearerToken({}),              null);
});

// requireUser — см. test/auth.test.js (полная реализация в 6.3.2).

// -----------------------------------------------------------------------------
// handlers/health.js
// -----------------------------------------------------------------------------

test('health: нет env-токена → 500 (намеренно)', async () => {
    delete process.env.PRIVATE_API_HEALTH_TOKEN;
    __setPoolForTest({ query: async () => ({ rows: [{ ok: 1 }] }) });

    const r = await healthHandler({ headers: {} }, { requestId: 'req-1' });
    assert.equal(r.statusCode, 500);

    __resetPoolForTest();
});

test('health: неверный Bearer → 401', async () => {
    process.env.PRIVATE_API_HEALTH_TOKEN = 'expected-secret';
    __setPoolForTest({ query: async () => ({ rows: [{ ok: 1 }] }) });

    const r = await healthHandler(
        { headers: { authorization: 'Bearer wrong' } },
        { requestId: 'req-2' }
    );
    assert.equal(r.statusCode, 401);

    delete process.env.PRIVATE_API_HEALTH_TOKEN;
    __resetPoolForTest();
});

test('health: корректный Bearer + БД отвечает → 200, db=true', async () => {
    process.env.PRIVATE_API_HEALTH_TOKEN = 'expected-secret';
    __setPoolForTest({ query: async () => ({ rows: [{ ok: 1 }] }) });

    const r = await healthHandler(
        withOrigin({ headers: { authorization: 'Bearer expected-secret' } }),
        { requestId: 'req-3' }
    );
    assert.equal(r.statusCode, 200);
    const body = parseBody(r);
    assert.equal(body.status, 'ok');
    assert.equal(body.db, true);
    assert.match(body.time, /\d{4}-\d{2}-\d{2}T/);

    delete process.env.PRIVATE_API_HEALTH_TOKEN;
    __resetPoolForTest();
});

test('health: БД упала → 500 без stack trace в теле', async () => {
    process.env.PRIVATE_API_HEALTH_TOKEN = 'expected-secret';
    __setPoolForTest({ query: async () => { throw new Error('db down: secret host=pg-master.local'); } });

    const r = await healthHandler(
        { headers: { authorization: 'Bearer expected-secret' } },
        { requestId: 'req-4' }
    );
    assert.equal(r.statusCode, 500);
    const body = parseBody(r);
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.requestId, 'req-4');
    // Подробности ошибки не должны утечь клиенту
    assert.ok(!r.body.includes('db down'),       'stack trace утёк в ответ');
    assert.ok(!r.body.includes('pg-master.local'), 'имя хоста утекло в ответ');

    delete process.env.PRIVATE_API_HEALTH_TOKEN;
    __resetPoolForTest();
});
