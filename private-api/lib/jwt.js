// =============================================================================
// jwt.js — генерация и валидация JWT-токенов авторизации.
//
// Алгоритм: HS256 (HMAC-SHA256, симметричный).
// Секрет: process.env.JWT_SECRET, минимум 32 байта. В проде — из Yandex
//   Lockbox; локально/в тестах — из .env или передаётся явно.
// Срок жизни: JWT_TTL_SECONDS env (по умолчанию 90 дней, ТЗ §3.6).
//
// Payload:
//   {
//     sub: <user_id>      — UUID пользователя из private_data.users.id
//     sid: <session_id>   — UUID сессии из private_data.auth_sessions.session_id
//     iat: <unix-seconds> — момент выпуска
//     exp: <unix-seconds> — момент истечения
//   }
//
// ★ Криптографическая верификация JWT — это ПЕРВЫЙ шаг.
//   Проверка того, что сессия не отозвана (auth_sessions.revoked_at IS NULL),
//   делается в lib/auth.js requireUser() (этап 6.3.2).
//
// Базируемся на `jose` — современная ESM-первая либа, async API.
// =============================================================================

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

const ALG = 'HS256';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 дней

// В serverless разные инстансы Cloud Functions могут иметь время с
// расхождением до секунды. JWT с exp ровно на границе → флапающий
// результат. ±5 секунд — разумный компромисс между UX и безопасностью.
const CLOCK_TOLERANCE_SECONDS = 5;

// -----------------------------------------------------------------------------
// JwtError — типизированные ошибки. Вызывающий код различает их по `code`,
// чтобы корректно мапить на HTTP-статусы (всегда 401, но разный лог).
// -----------------------------------------------------------------------------

export class JwtError extends Error {
    /**
     * @param {'no_secret'|'invalid_payload'|'expired'|'malformed'|'invalid'|'wrong_algorithm'} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'JwtError';
        this.code = code;
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getSecret() {
    const s = process.env.JWT_SECRET;
    if (!s || s.length < 32) {
        throw new JwtError('no_secret', 'JWT_SECRET не задан или короче 32 символов');
    }
    return new TextEncoder().encode(s);
}

function getTtlSeconds() {
    const raw = process.env.JWT_TTL_SECONDS;
    if (!raw) return DEFAULT_TTL_SECONDS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return DEFAULT_TTL_SECONDS;
    return n;
}

// -----------------------------------------------------------------------------
// signJwt — выпуск токена авторизации.
// -----------------------------------------------------------------------------

/**
 * @param {{ sub: string, sid: string }} payload
 * @param {{ ttlSeconds?: number }} [opts]
 * @returns {Promise<string>} compact JWS (header.payload.signature)
 */
export async function signJwt(payload, opts = {}) {
    if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new JwtError('invalid_payload', 'signJwt: { sub, sid } обязательны и должны быть строками');
    }
    const ttl = Number.isInteger(opts.ttlSeconds) && opts.ttlSeconds > 0
        ? opts.ttlSeconds
        : getTtlSeconds();

    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ sub: payload.sub, sid: payload.sid })
        .setProtectedHeader({ alg: ALG, typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .sign(getSecret());
    return jwt;
}

// -----------------------------------------------------------------------------
// verifyJwt — проверка подписи + срока. Возвращает payload или кидает JwtError.
// -----------------------------------------------------------------------------

/**
 * @param {string} token
 * @returns {Promise<{ sub: string, sid: string, iat: number, exp: number }>}
 * @throws {JwtError} с code из набора: 'expired' | 'invalid' | 'malformed' | 'wrong_algorithm'
 */
export async function verifyJwt(token) {
    if (typeof token !== 'string' || token.length === 0) {
        throw new JwtError('malformed', 'verifyJwt: пустой токен');
    }
    try {
        // ★ algorithms: [ALG] — pin на HS256. Без этого подмена alg на 'none'
        //   или RS256 (со своим публичным ключом) могла бы пройти.
        const { payload } = await jwtVerify(token, getSecret(), {
            algorithms: [ALG],
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
            throw new JwtError('invalid', 'verifyJwt: отсутствуют sub/sid в payload');
        }
        return {
            sub: payload.sub,
            sid: payload.sid,
            iat: payload.iat,
            exp: payload.exp,
        };
    } catch (e) {
        if (e instanceof JwtError) throw e;
        if (e instanceof joseErrors.JWTExpired)                  throw new JwtError('expired',           'JWT истёк');
        if (e instanceof joseErrors.JOSEAlgNotAllowed)           throw new JwtError('wrong_algorithm',   'JWT подписан недопустимым алгоритмом');
        if (e instanceof joseErrors.JWSSignatureVerificationFailed) throw new JwtError('invalid',         'Подпись JWT не сошлась');
        if (e instanceof joseErrors.JWSInvalid ||
            e instanceof joseErrors.JWTInvalid ||
            e instanceof joseErrors.JWTClaimValidationFailed)    throw new JwtError('malformed',         'JWT повреждён');
        // Незнакомый класс ошибки — считаем «invalid», логируем сообщение, но
        // НЕ прокидываем подробности дальше (это пошло бы в HTTP-ответ).
        throw new JwtError('invalid', `JWT verify failed: ${e?.name ?? 'Error'}`);
    }
}
