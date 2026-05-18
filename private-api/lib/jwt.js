// =============================================================================
// jwt.js — генерация и валидация JWT-токенов авторизации.
//
// ★ ЗАГЛУШКА для этапа 6.1 (каркас).
//   Реализация будет в этапе 6.3 (Auth basic flow) — там же согласуется
//   выбор библиотеки: jose / jsonwebtoken / ручной HS256 на crypto.
//
// По ТЗ v16 §3.6:
//   - Алгоритм: HS256 (HMAC-SHA256)
//   - Срок жизни: 90 дней (JWT_TTL_SECONDS env)
//   - Payload: { sub: user_id, sid: session_id, iat, exp }
//   - Возможность отзыва: проверка sid против таблицы auth_sessions
//     (revoked_at IS NULL)
//
// API этого модуля (контракт):
//   signJwt({ userId, sessionId })          → string
//   verifyJwt(token)                        → { userId, sessionId } | throws
//
// Кидаем именованные ошибки, чтобы вызывающий код мог отличить
// «токен невалиден» от «токен просрочен» от «нет секрета».
// =============================================================================

export class JwtError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'JwtError';
        this.code = code; // 'invalid' | 'expired' | 'no_secret'
    }
}

// TODO(6.3): реализовать HS256-подпись.
// Сейчас бросает явное исключение, чтобы случайный вызов не выдал
// «пустой» токен в продакшен.
export function signJwt(_payload) {
    throw new JwtError('not_implemented', 'signJwt будет реализован в этапе 6.3');
}

// TODO(6.3): реализовать HS256-валидацию + проверку exp/iat.
// Проверка отзыва (sid в auth_sessions) — отдельно, в lib/auth.js,
// потому что требует обращения к БД.
export function verifyJwt(_token) {
    throw new JwtError('not_implemented', 'verifyJwt будет реализован в этапе 6.3');
}
