// =============================================================================
// auth.js — извлечение и проверка авторизованного пользователя из запроса.
//
// Точка входа для handler'ов: requireUser(event).
//
// Что делает:
//   1. Достаёт Bearer-токен из Authorization header.
//   2. Валидирует JWT (lib/jwt.js verifyJwt — pin на HS256, exp, signature).
//   3. Атомарным UPDATE ... RETURNING проверяет сессию в auth_sessions:
//      жива (revoked_at IS NULL AND expires_at > now()) и одновременно
//      обновляет last_used_at = now(). Один round-trip к БД, без race.
//   4. Проверяет, что sub из JWT совпадает с user_id сессии в БД
//      (защита от склейки JWT одного юзера с session_id другого).
//   5. Возвращает { user_id, session_id }.
//
// Все негативные сценарии — типизированный AuthError. Handler ловит,
// маппит на 401 unauthorized() и пишет в лог код + (для отладки)
// маскированный session_id.
//
// ★ Различение "сессия не найдена / отозвана / истекла" в HTTP-ответе
//   намеренно НЕ делается — это дало бы атакующему вектор разведки
//   (отозвана = юзер сменил пароль, истекла = давно не заходил и т.д.).
//   Для нашего лога различение можно делать отдельным запросом, но в
//   проде по hot path этого не делаем — лишний round-trip.
// =============================================================================

import { getPool } from './db.js';
import { verifyJwt, JwtError } from './jwt.js';
import { maskToken } from './mask-pii.js';

export class AuthError extends Error {
    /**
     * @param {'no_token'|'malformed_token'|'jwt_invalid'|'session_invalid'|'session_mismatch'} code
     * @param {string} message
     * @param {{ cause?: string }} [opts] — подкод (например, expired/invalid/malformed для jwt_invalid)
     */
    constructor(code, message, { cause } = {}) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/**
 * Достаёт Bearer-токен из заголовка Authorization (case-insensitive имя
 * заголовка, case-sensitive scheme — RFC 6750 даёт обе формы).
 * Возвращает строку или null.
 */
export function extractBearerToken(event) {
    const h = event?.headers ?? {};
    const raw = h.authorization ?? h.Authorization ?? '';
    if (typeof raw !== 'string') return null;
    const m = raw.match(/^Bearer\s+(.+)$/);
    return m ? m[1].trim() : null;
}

/**
 * Главный middleware-style хелпер.
 *
 * @param {object} event — Yandex Cloud Functions event
 * @param {{ pool?: object }} [deps] — инъекция pool для тестов (по умолчанию getPool())
 * @returns {Promise<{ user_id: string, session_id: string }>}
 * @throws {AuthError}
 */
export async function requireUser(event, deps = {}) {
    const pool = deps.pool ?? getPool();

    // ─── 1. Парсинг Authorization header ──────────────────────────────────────
    const rawAuth = event?.headers?.authorization ?? event?.headers?.Authorization;
    if (rawAuth == null || rawAuth === '') {
        throw new AuthError('no_token', 'Authorization header отсутствует');
    }
    if (typeof rawAuth !== 'string' || !/^Bearer\s+/.test(rawAuth)) {
        // Wrong scheme (Basic, Digest, etc.) — это malformed, не no_token.
        throw new AuthError('malformed_token', 'Ожидается "Bearer <token>"');
    }
    const token = extractBearerToken(event);
    if (!token) {
        throw new AuthError('malformed_token', 'Bearer без токена');
    }

    // ─── 2. JWT-валидация ─────────────────────────────────────────────────────
    let jwtPayload;
    try {
        jwtPayload = await verifyJwt(token);
    } catch (e) {
        if (e instanceof JwtError) {
            // Подкод (e.code) — для нашего лога. В HTTP-ответе всё равно 401.
            throw new AuthError('jwt_invalid', 'JWT не прошёл проверку', { cause: e.code });
        }
        throw e;
    }
    const userIdFromJwt = jwtPayload.sub;
    const sessionId     = jwtPayload.sid;

    // ─── 3. Атомарный UPDATE ... RETURNING сессии ─────────────────────────────
    // Условия в WHERE — это И проверка валидности, И защита от race с
    // logout-all (если revoked_at успели поставить параллельно).
    const { rows } = await pool.query(
        `UPDATE private_data.auth_sessions
         SET last_used_at = now()
         WHERE session_id = $1
           AND revoked_at IS NULL
           AND expires_at > now()
         RETURNING user_id`,
        [sessionId],
    );

    if (rows.length === 0) {
        // Различение "нет / отозвана / истекла" в HTTP-ответе мы намеренно
        // не делаем — это разведка для атакующего (отозвана = юзер сменил
        // пароль, истекла = давно не заходил). Но в ЛОГЕ различаем, чтобы
        // отличать нормальный churn от попыток подбора JWT.
        //
        // Это плохой путь (≤1% запросов), доп. SELECT здесь окей.
        const { rows: details } = await pool.query(
            `SELECT (revoked_at IS NOT NULL) AS revoked,
                    (expires_at < now())     AS expired
               FROM private_data.auth_sessions
              WHERE session_id = $1`,
            [sessionId],
        );

        let cause;
        if (details.length === 0)         cause = 'session_not_found';
        else if (details[0].revoked)      cause = 'session_revoked';
        else if (details[0].expired)      cause = 'session_expired';
        else                              cause = 'session_invalid_unknown';   // ← маркер бага

        console.warn('[auth] session_invalid', {
            sid: maskToken(sessionId),
            cause,
        });
        throw new AuthError('session_invalid', 'Сессия недействительна', { cause });
    }

    // ─── 4. Защита от подмены: sub в JWT vs user_id в БД ──────────────────────
    if (rows[0].user_id !== userIdFromJwt) {
        console.warn('[auth] session_mismatch', { sid: maskToken(sessionId) });
        throw new AuthError('session_mismatch', 'sub из JWT не совпадает с user_id сессии');
    }

    return { user_id: rows[0].user_id, session_id: sessionId };
}
