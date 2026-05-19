// =============================================================================
// POST /api/account/cancel-deletion
//
// Авторизованный. Отмена soft-delete в окне grace period.
//
// Flow для юзера: после /delete-confirm все сессии revoked → клиент
// получает 401 → проходит /auth/start + /auth/verify с тем же phone →
// получает свежий JWT → дёргает этот endpoint.
//
// /auth/start не блокирует login для user'а в pending deletion — он
// найдёт по phone и пустит через flash_call/magic_link. Это намеренно:
// окно cancel-deletion должно быть достижимо.
//
// Защитные ветки:
//   - already_deleted (deletion_completed_at != NULL)   → 410
//     На практике сессий у такого user'а уже нет (cron CASCADE).
//   - nothing_to_cancel (deletion_scheduled_at IS NULL) → 409
//   - grace_period_expired (scheduled_at <= now)        → 410
//
// ★ Sessions НЕ восстанавливаем. После cancel юзер логинится снова
//   (как и до отмены). Это безопасно: revoked сессии — это правильная
//   защита, юзер просто получит новую сессию через тот же /auth/verify.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, conflict, gone, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const user = (await pool.query(
            `SELECT deletion_scheduled_at, deletion_completed_at
               FROM private_data.users
              WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!user) {
            console.error('[account.cancel_deletion.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        if (user.deletion_completed_at != null) {
            return gone({ error: 'already_deleted' }, { origin });
        }
        if (user.deletion_scheduled_at == null) {
            return conflict({ error: 'nothing_to_cancel' }, { origin });
        }
        if (new Date(user.deletion_scheduled_at).getTime() <= Date.now()) {
            return gone({ error: 'grace_period_expired' }, { origin });
        }

        // ─── Атомарное снятие — race против cron ────────────────────────────
        // Защита от scenario «cron уже сделал claim»: WHERE deletion_completed_at
        // IS NULL AND deletion_scheduled_at > $now. Если cron успел — 0 rows.
        const nowIso = new Date().toISOString();
        const restored = (await pool.query(
            `UPDATE private_data.users
                SET deletion_requested_at = NULL,
                    deletion_scheduled_at = NULL
              WHERE id = $1
                AND deletion_completed_at IS NULL
                AND deletion_scheduled_at IS NOT NULL
                AND deletion_scheduled_at > $2
              RETURNING id`,
            [userId, nowIso],
        )).rows;
        if (restored.length === 0) {
            // Cron'у удалось забрать первым между нашими SELECT и UPDATE.
            // Видим из БД, что уже completed либо grace истёк — отвечаем
            // адекватно. Перепроверим состояние, чтобы дать осмысленный ответ.
            const recheck = (await pool.query(
                `SELECT deletion_completed_at, deletion_scheduled_at
                   FROM private_data.users WHERE id = $1`,
                [userId],
            )).rows[0];
            if (recheck?.deletion_completed_at != null) {
                return gone({ error: 'already_deleted' }, { origin });
            }
            return gone({ error: 'grace_period_expired' }, { origin });
        }

        await pool.query(
            `INSERT INTO private_data.events_log (user_id, event_type)
             VALUES ($1, 'deletion_cancelled')`,
            [userId],
        );

        console.log('[account.deletion_cancelled]', {
            request_id: requestId, user_id: userId,
            previously_scheduled_at: toIso(user.deletion_scheduled_at),
        });

        return ok({
            restored: true,
            message:  'Запрос на удаление отменён. Доступ к сервису восстановлен.',
        }, { origin });
    } catch (err) {
        console.error('[account.cancel_deletion]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
