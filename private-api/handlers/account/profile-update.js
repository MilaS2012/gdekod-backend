// =============================================================================
// PATCH /api/account/profile
//
// Авторизованный. Обновляет display_name (другие поля профиля редактируются
// отдельными endpoints — email через /auth/email/attach, phone через
// сменa номера в /auth/start с другим номером).
//
// Валидация display_name:
//   - строка 1..50 символов после trim()
//   - не содержит управляющих символов (\n, \t, \r, \0)
//   - не пустая после trim()
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../../lib/response.js';
import { maskPhone } from '../../lib/mask-pii.js';

const MAX_DISPLAY_NAME_LEN = 50;
// Запрещаем управляющие символы (включая \n, \t, \r, NUL и пр.).
const CTRL_RE = /[\x00-\x1F\x7F]/;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')          return corsPreflight(origin);
    if (method && method !== 'PATCH')  return methodNotAllowed(['PATCH', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_display_name', { origin });

        const raw = typeof body.display_name === 'string' ? body.display_name : null;
        if (raw == null) return badRequest('invalid_display_name', { origin });

        const trimmed = raw.trim();
        if (trimmed.length === 0
            || trimmed.length > MAX_DISPLAY_NAME_LEN
            || CTRL_RE.test(trimmed)) {
            return badRequest('invalid_display_name', { origin });
        }

        const row = (await pool.query(
            `UPDATE private_data.users
                SET display_name       = $1,
                    profile_updated_at = now()
              WHERE id = $2
              RETURNING id, phone, display_name, email, email_verified_at,
                        created_at, profile_updated_at,
                        email_reminder_dismissed_count`,
            [trimmed, userId],
        )).rows[0];

        if (!row) {
            console.error('[account.profile.update.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        console.log('[account.profile.update]', {
            request_id: requestId, user_id: userId,
            has_display_name: row.display_name != null,
        });

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
        console.error('[account.profile.update]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
