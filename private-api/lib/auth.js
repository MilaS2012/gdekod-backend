// =============================================================================
// auth.js — извлечение и проверка пользователя из запроса.
//
// ★ ЗАГЛУШКА для этапа 6.1 (каркас).
//   Полная реализация — в этапе 6.3 после согласования JWT-библиотеки.
//
// Контракт (для использования в handler'ах):
//
//   const auth = await requireUser(event);
//   if (auth.error) return auth.error;   // готовый HTTP-response (401)
//   const { userId, sessionId } = auth;
//
// Извлекает Bearer-токен из заголовка Authorization, валидирует JWT
// (lib/jwt.js), проверяет, что сессия не отозвана (auth_sessions),
// и возвращает либо { userId, sessionId }, либо { error: response401 }.
//
// Логи — только user_id и абстрактные коды причин. Сам токен в лог
// попадает только через maskToken() и только если это нужно для дебага.
// =============================================================================

import { unauthorized } from './response.js';
// import { verifyJwt, JwtError } from './jwt.js';  // (этап 6.3)
// import { getPool } from './db.js';                // (этап 6.3)
// import { maskToken } from './mask-pii.js';        // (этап 6.3)

/**
 * Достаёт Bearer-токен из заголовка Authorization (case-insensitive).
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
 * Главный middleware-стайл хелпер.
 *
 * TODO(6.3):
 *   1. extractBearerToken → если нет → unauthorized()
 *   2. verifyJwt(token) → { userId, sessionId }, ловить JwtError
 *   3. SELECT 1 FROM private_data.auth_sessions
 *      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
 *      → если нет — unauthorized() (сессия отозвана через logout-all)
 *   4. Обновить last_seen_at у сессии (опц., можно не на каждом запросе)
 *   5. Вернуть { userId, sessionId }
 *
 * Возвращает либо { userId, sessionId } при успехе,
 * либо { error: <http-response 401> } при ошибке.
 */
// eslint-disable-next-line no-unused-vars
export async function requireUser(event) {
    // На 6.1 — короткая 401. Реальная логика — в 6.3.
    return { error: unauthorized('Auth не реализован (этап 6.1, заглушка)') };
}
