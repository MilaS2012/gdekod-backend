// =============================================================================
// POST /api/auth/logout-all
//
// Авторизованный. Отзывает ВСЕ живые сессии этого user'а — включая
// текущую, с которой пришёл запрос. После этого юзеру придётся
// залогиниться заново.
//
// Race-safe: один атомарный UPDATE ... WHERE revoked_at IS NULL
// RETURNING session_id. Параллельный logout-all из другой сессии того
// же user'а пометит те же rows (idempotent) или часть из них, и
// финальный revoked_count может быть меньше количества живых сессий
// в момент запуска. Это OK для семантики «выйти везде».
//
// Контракт ответа: 200 { revoked_count }.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin,
} from '../../lib/response.js';
import { maskToken } from '../../lib/mask-pii.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    let triggeredBySid = null;
    try {
        // ─── 1. requireUser ──────────────────────────────────────────────────
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId         = auth.user_id;
        triggeredBySid = auth.session_id;

        // ─── 2. Атомарный revoke всех живых сессий user'а ────────────────────
        const rows = (await pool.query(
            `UPDATE private_data.auth_sessions
                SET revoked_at = now()
              WHERE user_id = $1
                AND revoked_at IS NULL
              RETURNING session_id`,
            [userId],
        )).rows;

        console.log('[auth.logout_all]', {
            request_id:             requestId,
            user_id:                userId,
            revoked_count:          rows.length,
            triggered_by_sid_mask:  maskToken(triggeredBySid),
        });

        return ok({ revoked_count: rows.length }, { origin });
    } catch (err) {
        console.error('[auth.logout_all]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
