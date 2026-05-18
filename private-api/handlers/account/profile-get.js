// =============================================================================
// GET /api/account/profile
//
// Авторизованный. Возвращает профиль текущего пользователя.
//
// ★ phone маскируется ДАЖЕ в собственном профиле — защита от подсматривания
//   экрана и от случайного появления полного телефона в скриншотах фронта.
//   Email отдаётся целиком — это его контактный канал, он должен его видеть.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { maskPhone } from '../../lib/mask-pii.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'GET')  return methodNotAllowed(['GET', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const row = (await pool.query(
            `SELECT id, phone, display_name,
                    email, email_verified_at,
                    created_at, profile_updated_at,
                    email_reminder_dismissed_count
               FROM private_data.users
              WHERE id = $1`,
            [userId],
        )).rows[0];

        if (!row) {
            // Логически невозможно — auth_session требует существующего user.
            console.error('[account.profile.get.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        return ok({
            profile: {
                id:                       row.id,
                phone_masked:             maskPhone(row.phone),
                display_name:             row.display_name || null,
                email:                    row.email || null,
                email_verified:           row.email_verified_at != null,
                registered_at:            toIso(row.created_at),
                profile_updated_at:       toIso(row.profile_updated_at),
                banner_dismissed_count:   row.email_reminder_dismissed_count,
            },
        }, { origin });
    } catch (err) {
        console.error('[account.profile.get]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
