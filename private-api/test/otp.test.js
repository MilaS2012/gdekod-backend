// =============================================================================
// otp.test.js — generateOtpCode + hashOtpCode + verifyOtpCode.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateOtpCode, hashOtpCode, verifyOtpCode, OTP_LENGTH } from '../lib/otp.js';

const OTP_SECRET = 'otp-hmac-test-secret-min-32-bytes-XXXX';

function setEnv() { process.env.OTP_HMAC_SECRET = OTP_SECRET; }
function resetEnv() { delete process.env.OTP_HMAC_SECRET; }

// -----------------------------------------------------------------------------
// generateOtpCode
// -----------------------------------------------------------------------------

test('generateOtpCode(4): ровно 4 цифры, включая ведущие нули', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
        const c = generateOtpCode(4);
        assert.match(c, /^\d{4}$/);
        seen.add(c);
    }
    // 200 кодов из 10_000 → большой спред, шанс совпадений есть, но >100 уникальных гарантированно.
    assert.ok(seen.size > 100, `мало уникальности: ${seen.size}/200`);
});

test('generateOtpCode(6): ровно 6 цифр', () => {
    for (let i = 0; i < 50; i++) {
        assert.match(generateOtpCode(6), /^\d{6}$/);
    }
});

test('generateOtpCode: невалидная длина → throws', () => {
    assert.throws(() => generateOtpCode(3),   /4\.\.6/);
    assert.throws(() => generateOtpCode(7),   /4\.\.6/);
    assert.throws(() => generateOtpCode(0),   /4\.\.6/);
    assert.throws(() => generateOtpCode(-1),  /4\.\.6/);
    assert.throws(() => generateOtpCode('4'), /4\.\.6/);
    assert.throws(() => generateOtpCode(4.5), /4\.\.6/);
    assert.throws(() => generateOtpCode(),    /4\.\.6/);
});

test('OTP_LENGTH: маппинг каналов', () => {
    assert.equal(OTP_LENGTH.flash_call, 4);
    assert.equal(OTP_LENGTH.voice,      4);
    assert.equal(OTP_LENGTH.sms,        6);
    // frozen
    assert.throws(() => { OTP_LENGTH.flash_call = 99; }, TypeError);
});

// -----------------------------------------------------------------------------
// hashOtpCode
// -----------------------------------------------------------------------------

test('hashOtpCode: 64 hex символа', () => {
    setEnv();
    const h = hashOtpCode('123456');
    assert.match(h, /^[0-9a-f]{64}$/);
    resetEnv();
});

test('hashOtpCode: детерминированно — один код, один секрет → один hash', () => {
    setEnv();
    assert.equal(hashOtpCode('000000'), hashOtpCode('000000'));
    assert.equal(hashOtpCode('999999'), hashOtpCode('999999'));
    resetEnv();
});

test('hashOtpCode: разные коды → разные hash', () => {
    setEnv();
    assert.notEqual(hashOtpCode('123456'), hashOtpCode('123457'));
    assert.notEqual(hashOtpCode('000000'), hashOtpCode('999999'));
    resetEnv();
});

test('hashOtpCode: разные секреты → разные hash для одного кода', () => {
    setEnv();
    const h1 = hashOtpCode('123456');
    process.env.OTP_HMAC_SECRET = 'different-secret-min-32-bytes-YYYYY';
    const h2 = hashOtpCode('123456');
    assert.notEqual(h1, h2);
    resetEnv();
});

test('hashOtpCode: нет секрета → throws', () => {
    resetEnv();
    assert.throws(() => hashOtpCode('123456'), /OTP_HMAC_SECRET/);
});

test('hashOtpCode: секрет короче 32 символов → throws', () => {
    process.env.OTP_HMAC_SECRET = 'short';
    assert.throws(() => hashOtpCode('123456'), /короче 32/);
    resetEnv();
});

test('hashOtpCode: невалидный код → throws', () => {
    setEnv();
    assert.throws(() => hashOtpCode('abc'),     /4\.\.8 цифр/);
    assert.throws(() => hashOtpCode(''),        /4\.\.8 цифр/);
    assert.throws(() => hashOtpCode('123'),     /4\.\.8 цифр/);
    assert.throws(() => hashOtpCode('123456789'), /4\.\.8 цифр/);
    resetEnv();
});

// -----------------------------------------------------------------------------
// verifyOtpCode (constant-time)
// -----------------------------------------------------------------------------

test('verifyOtpCode: правильный код → true', () => {
    setEnv();
    const h = hashOtpCode('654321');
    assert.equal(verifyOtpCode('654321', h), true);
    resetEnv();
});

test('verifyOtpCode: неправильный код → false', () => {
    setEnv();
    const h = hashOtpCode('654321');
    assert.equal(verifyOtpCode('654322', h), false);
    resetEnv();
});

test('verifyOtpCode: повреждённый hash → false, без throws', () => {
    setEnv();
    assert.equal(verifyOtpCode('123456', 'too-short'),  false);
    assert.equal(verifyOtpCode('123456', null),         false);
    assert.equal(verifyOtpCode('123456', 'g'.repeat(64)), false); // не hex
    resetEnv();
});
