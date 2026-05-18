// =============================================================================
// otp.js — генерация и хеширование одноразовых OTP-кодов.
//
// Plain-код хранится только в SMS / Flash Call / Voice-канале (отправляется
// пользователю один раз). В БД otp_codes.code_hash — HMAC-SHA256(secret, code),
// 64 hex-символа. Сравнение при /auth/verify — constant-time.
//
// Решение по криптографии: один общий OTP_HMAC_SECRET в env (Yandex Lockbox).
// Per-row salt не используется — для 4-6-значного OTP с TTL 5 минут и
// attempts_count ≤ 5 он не даёт практической пользы (онлайн-атака невозможна,
// offline-brute уже защищён HMAC + секретом).
// =============================================================================

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const HMAC_HEX_LENGTH = 64;

/**
 * Длина OTP-кода для каждого канала.
 * - flash_call/voice: 4 цифры (последние цифры номера-звонящего)
 * - sms: 6 цифр (классический формат)
 * Канал → длина — единая точка истины, чтобы не разбрасывать
 * магические числа по handler'ам.
 */
export const OTP_LENGTH = Object.freeze({
    flash_call: 4,
    voice:      4,
    sms:        6,
});

/**
 * Генерирует криптографически случайный код заданной длины с сохранением
 * ведущих нулей. Использует randomInt (CSPRNG), не Math.random.
 *
 * @param {number} length — 4..6 цифр (см. OTP_LENGTH)
 */
export function generateOtpCode(length) {
    if (!Number.isInteger(length) || length < 4 || length > 6) {
        throw new Error('generateOtpCode: length must be 4..6');
    }
    const n = randomInt(0, 10 ** length);
    return String(n).padStart(length, '0');
}

/**
 * Хеширует код через HMAC-SHA256 с секретом из env.
 * Возвращает 64-символьный hex.
 */
export function hashOtpCode(code) {
    assertCode(code);
    const secret = process.env.OTP_HMAC_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('OTP_HMAC_SECRET не задан или короче 32 символов');
    }
    return createHmac('sha256', secret).update(code).digest('hex');
}

/**
 * Constant-time сравнение хеша из БД с хешем введённого кода.
 * Используется в /auth/verify — критично для защиты от timing-атак
 * на угадывание кода.
 */
export function verifyOtpCode(plainCode, storedHash) {
    if (typeof storedHash !== 'string' || storedHash.length !== HMAC_HEX_LENGTH) {
        return false;
    }
    let computed;
    try { computed = hashOtpCode(plainCode); }
    catch { return false; }
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function assertCode(code) {
    if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
        throw new Error('OTP code должен быть 4..8 цифр');
    }
}
