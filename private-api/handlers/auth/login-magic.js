// =============================================================================
// POST /api/auth/login-magic
//
// Юзер кликает по ссылке из письма "Войти в ГдеКод" (ТЗ §3.7.9, §3.7.10).
// Фронт извлекает token из URL и шлёт сюда. Мы проверяем → выпускаем JWT.
//
// Контракт ответа: 200 { jwt }
//   Только JWT. session_id — внутри payload (sid), не дублируется.
//
// Race-safe pattern (без BEGIN/COMMIT, как в /verify):
//   Шаг 3 — атомарный UPDATE WHERE used_at IS NULL AND expires_at > now()
//           RETURNING user_id. Если 0 rows — токен не существует / истёк /
//           уже использован — единый 401 invalid_or_expired (защита от
//           разведки причины атакующим).
//
// Документированное ограничение: если между UPDATE magic_link_tokens и
// INSERT auth_sessions упадёт сеть — токен помечен used, сессия не создана,
// юзер запросит новую ссылку. Не откатываем (см. шапку verify.js).
//
// Rate-limit на самом /login-magic НЕТ:
//   - magic-link токен = 256 бит энтропии, неперебираем
//   - DDoS-защиту по IP делаем на уровне reverse-proxy в 6.10
// Rate-limit на ВЫДАЧУ magic-link стоит в /auth/start (emailRateCheck).
//
// Стратегия с другими magic_link_tokens этого user'а (согласовано 6.3.6):
// НЕ инвалидируем. Каждый токен сам истекает за 30 минут. Перехват одного
// и одновременная инвалидация других — событие, не покрываемое 30-минутным
// окном уникальности (если перехвачен один — мог быть перехвачен и другой).
// =============================================================================

import { getPool } from '../../lib/db.js';
import {
    ok, badRequest, unauthorized, methodNotAllowed, serverError,
    corsPreflight, parseJsonBody, getOrigin,
} from '../../lib/response.js';
import { signJwt } from '../../lib/jwt.js';
import { maskIp, maskToken } from '../../lib/mask-pii.js';
import { extractIp, extractUserAgent, userAgentHash } from '../../lib/event.js';

// magic_link_token = 32 байта base64url ≈ 43 символа. Допускаем 40-48 с запасом.
const TOKEN_RE = /^[A-Za-z0-9_-]{40,48}$/;
const SESSION_TTL_DAYS = 90;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let tokenMaskForLog = '***';
    try {
        // ─── 1. Парсинг + валидация ───────────────────────────────────────────
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_token', { origin });
        const token = typeof body.token === 'string' ? body.token.trim() : null;
        if (!token || !TOKEN_RE.test(token)) {
            return badRequest('invalid_token', { origin });
        }
        tokenMaskForLog = maskToken(token);

        const ip = extractIp(event);

        // ─── 2. Атомарная пометка used + получение user_id ────────────────────
        const claimed = (await pool.query(
            `UPDATE private_data.magic_link_tokens
                SET used_at = now()
              WHERE token = $1
                AND used_at IS NULL
                AND expires_at > now()
              RETURNING user_id`,
            [token],
        )).rows;
        if (claimed.length === 0) {
            // Один HTTP-ответ для трёх причин (не найден / истёк / used) —
            // защита от разведки.
            console.warn('[auth.login_magic.failed]', {
                request_id: requestId, token_mask: tokenMaskForLog,
                ip_mask: maskIp(ip), reason: 'invalid_or_expired',
            });
            return unauthorized('invalid_or_expired', { origin });
        }
        const userId = claimed[0].user_id;

        // ─── 3. SELECT user (sanity check) ────────────────────────────────────
        const user = (await pool.query(
            `SELECT id FROM private_data.users WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!user) {
            // Логически невозможно (CASCADE удалил бы magic_link_token при
            // удалении user). Защитная ветка: лог + 500.
            console.error('[auth.login_magic.anomaly]', {
                request_id: requestId, token_mask: tokenMaskForLog,
                user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        // ─── 4. INSERT auth_sessions ──────────────────────────────────────────
        const uaHash  = userAgentHash(extractUserAgent(event));
        const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);

        let session;
        try {
            session = (await pool.query(
                `INSERT INTO private_data.auth_sessions
                   (user_id, expires_at, ip_address, user_agent_hash)
                 VALUES ($1, $2, $3, $4)
                 RETURNING session_id`,
                [user.id, expires, ip, uaHash],
            )).rows[0];
        } catch (err) {
            // Токен уже used, сессии нет. Не откатываем (см. шапку).
            console.error('[auth.login_magic.session_creation_failed]', {
                request_id: requestId, token_mask: tokenMaskForLog,
                user_id: user.id, message: err?.message,
            });
            return serverError({ origin, requestId });
        }

        // ─── 5. signJwt ───────────────────────────────────────────────────────
        const jwt = await signJwt({ sub: user.id, sid: session.session_id });

        console.log('[auth.login_magic.success]', {
            request_id: requestId,
            token_mask: tokenMaskForLog,
            ip_mask:    maskIp(ip),
            user_id:    user.id,
            sid_mask:   maskToken(session.session_id),
        });

        return ok({ jwt }, { origin });
    } catch (err) {
        console.error('[auth.login_magic]', {
            request_id: requestId, token_mask: tokenMaskForLog, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
