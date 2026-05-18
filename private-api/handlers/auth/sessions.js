// =============================================================================
// GET /api/auth/sessions
//
// Авторизованный. Список живых сессий пользователя для раздела
// «Настройки → Устройства». Текущая (та, с которой пришёл запрос) —
// всегда первая в списке, помечена is_current=true.
//
// Контракт ответа (ТЗ v16.1 §19.2):
//   200 {
//     sessions: [{
//       session_id: string,
//       is_current: boolean,
//       created_at: ISO,
//       last_used_at: ISO | null,
//       expires_at: ISO,
//       ip_masked: string,
//       device_info: string   // из user_agent_summary
//     }]
//   }
//
// Безопасность: НЕ возвращаем полный IP, user_agent_hash, revoked_at.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { maskIp } from '../../lib/mask-pii.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 20;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')                       return corsPreflight(origin);
    if (method && method !== 'GET')                 return methodNotAllowed(['GET', 'OPTIONS'], { origin });

    let userId = null;
    let currentSid = null;
    try {
        // ─── 1. requireUser → user_id + current sid ──────────────────────────
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId     = auth.user_id;
        currentSid = auth.session_id;

        // ─── 2. Парсинг limit ────────────────────────────────────────────────
        const rawLimit = event?.queryStringParameters?.limit
                        ?? event?.queryStringParameters?.Limit;
        let limit = DEFAULT_LIMIT;
        if (rawLimit != null) {
            const n = Number(rawLimit);
            if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
                return badRequest('invalid_limit', { origin });
            }
            limit = n;
        }

        // ─── 3. SELECT живых сессий (порядок recency, JS делает current-first) ─
        // CASE в ORDER BY работает в Postgres, но pg-mem нестабилен на нём.
        // Сортируем в JS — массив до MAX_LIMIT (20) записей, микросекунды.
        const rows = (await pool.query(
            `SELECT session_id, created_at, last_used_at, expires_at,
                    ip_address, user_agent_summary
               FROM private_data.auth_sessions
              WHERE user_id = $1
                AND revoked_at IS NULL
                AND expires_at > now()
              ORDER BY last_used_at DESC NULLS LAST, created_at DESC
              LIMIT $2`,
            [userId, limit],
        )).rows;

        // JS-сортировка: current сессия первая.
        const currentRow = rows.find(r => r.session_id === currentSid);
        const otherRows  = rows.filter(r => r.session_id !== currentSid);
        const sorted     = currentRow ? [currentRow, ...otherRows] : rows;

        const sessions = sorted.map(r => ({
            session_id:   r.session_id,
            is_current:   r.session_id === currentSid,
            created_at:   toIso(r.created_at),
            last_used_at: toIso(r.last_used_at),
            expires_at:   toIso(r.expires_at),
            ip_masked:    maskIp(r.ip_address == null ? null : String(r.ip_address)),
            device_info:  r.user_agent_summary || 'Unknown device',
        }));

        console.log('[auth.sessions.list]', {
            request_id: requestId, user_id: userId, count: sessions.length,
        });

        return ok({ sessions }, { origin });
    } catch (err) {
        console.error('[auth.sessions.list]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
