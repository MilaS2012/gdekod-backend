// =============================================================================
// otp.js — генерация и хеширование одноразовых OTP-кодов.
//
// Plain-код хранится только в SMS / Flash Call / Voice-канале (отправляется
// пользователю один раз). В БД otp_codes.code_hash — HMAC-SHA256(secret, code),
// 64 hex-символа. Сравнение при /auth/verify — constant-time.
//
// Решение по криптографии: один общий OTP_HMAC_SECRET в env (Yandex Lockbox).
// Per-row salt не используется — для 6-значного OTP с TTL 5 минут и
// attempts_count ≤ 5 он не даёт практической пользы (онлайн-атака невозможна,
// offline-brute уже защищён HMAC + секретом).
// =============================================================================

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_LENGTH = 6;
const HMAC_HEX_LENGTH = 64;

/**
 * Генерирует криптографически случайный 6-значный код с сохранением ведущих нулей.
 * Использует randomInt (CSPRNG), не Math.random.
 */
export function generateOtpCode() {
    const n = randomInt(0, 10 ** CODE_LENGTH);
    return String(n).padStart(CODE_LENGTH, '0');
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
 * Используется в /auth/verify (6.3.5) — критично для защиты от
 * timing-атак на угадывание кода.
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
