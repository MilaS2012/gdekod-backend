// =============================================================================
// POST /api/auth/banner/dismiss
//
// Авторизованный. Юзер нажал «Позже» на баннере «Привяжи email» в ЛК.
// Инкрементируем счётчик отказов; после 3 dismiss подряд баннер уезжает
// в Настройки → Безопасность и автоматически больше не показывается
// (логика показа — на стороне фронта по hidden_permanently).
//
// Контракт ответа: 200 { dismissed_count, hidden_permanently }.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin,
} from '../../lib/response.js';

const HIDE_THRESHOLD = 3;  // ТЗ §3.7.3: после 3 dismiss подряд → в Настройки

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    try {
        // ─── 1. requireUser ──────────────────────────────────────────────────
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        // ─── 2. Атомарный инкремент через RETURNING ──────────────────────────
        const rows = (await pool.query(
            `UPDATE private_data.users
                SET email_reminder_dismissed_count = email_reminder_dismissed_count + 1,
                    email_reminder_dismissed_at    = now()
              WHERE id = $1
              RETURNING email_reminder_dismissed_count AS new_count`,
            [userId],
        )).rows;
        if (rows.length === 0) {
            // Логически невозможно — auth_session жива → user в БД.
            console.error('[auth.banner.dismiss.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }
        const newCount = rows[0].new_count;
        const hidden   = newCount >= HIDE_THRESHOLD;

        console.log('[auth.banner.dismiss]', {
            request_id: requestId, user_id: userId, new_count: newCount,
            hidden_permanently: hidden,
        });

        return ok({ dismissed_count: newCount, hidden_permanently: hidden }, { origin });
    } catch (err) {
        console.error('[auth.banner.dismiss]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
