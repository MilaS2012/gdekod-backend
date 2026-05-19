// =============================================================================
// POST /api/account/delete-confirm
//
// Авторизованный. Шаг 2 удаления: подтверждение OTP, отмеченного в шаге 1.
//
// Input: { otp_code: string (6 digits) }
//
// При успехе:
//   1. UPDATE users: deletion_requested_at=now(), deletion_scheduled_at=now+24h
//   2. Revoke ВСЕХ сессий user'а (он не должен продолжать пользоваться
//      сервисом после запроса на удаление — спека 6.9)
//   3. Cancel активную подписку (если есть)
//   4. INSERT events_log event_type='deletion_scheduled'
//   5. notifyTransactional kind='account_deletion_scheduled'
//   6. Ответ с deletion_scheduled_at + grace_period_hours + cancel_url
//
// ★ OTP-валидация в стиле /auth/verify (constant-time + brute-force защита +
//   atomic used_at). Дублируем флоу осознанно — выделять в helper рано
//   (только 2 call site, и flow специфичный по таблице).
//
// ★ После confirm все sessions revoked — текущая сессия тоже. JWT
//   у клиента после этого 401. Восстановление доступа — через
//   /auth/start (новый login).
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, conflict, gone, unauthorized,
    serverError, corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../../lib/response.js';
import { verifyOtpCode } from '../../lib/otp.js';
import { notifyTransactional } from '../../lib/notifications.js';
import { maskPhone } from '../../lib/mask-pii.js';
import {
    DELETION_GRACE_PERIOD_HOURS,
    DELETION_OTP_MAX_ATTEMPTS,
} from '../../lib/account-deletion-config.js';

const CODE_RE = /^\d{6}$/;

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

        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });
        const code = typeof body.otp_code === 'string' ? body.otp_code.trim() : null;
        if (!code || !CODE_RE.test(code)) return badRequest('invalid_input', { origin });

        // ─── Защитные ветки текущего состояния ──────────────────────────────
        const user = (await pool.query(
            `SELECT id, phone, deletion_scheduled_at, deletion_completed_at
               FROM private_data.users
              WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!user) {
            console.error('[account.delete_confirm.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }
        if (user.deletion_completed_at != null) {
            return gone({ error: 'already_deleted' }, { origin });
        }
        if (user.deletion_scheduled_at != null) {
            return conflict({
                error: 'deletion_already_pending',
                deletion_scheduled_at: toIso(user.deletion_scheduled_at),
            }, { origin });
        }

        // ─── Валидация OTP (зеркало /auth/verify, чуть упрощённое) ──────────
        const otp = (await pool.query(
            `SELECT id, code_hash, expires_at, attempts_count
               FROM private_data.account_deletion_otp_codes
              WHERE user_id = $1
                AND used_at IS NULL
                AND expires_at > now()
              ORDER BY created_at DESC
              LIMIT 1`,
            [userId],
        )).rows[0];

        const phoneMask = maskPhone(user.phone);
        if (!otp) {
            console.warn('[account.delete_confirm.failed]', {
                request_id: requestId, user_id: userId,
                phone_mask: phoneMask, reason: 'no_active_otp',
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        if (otp.attempts_count >= DELETION_OTP_MAX_ATTEMPTS) {
            // Гасим, чтобы дальше не лупили.
            await pool.query(
                `UPDATE private_data.account_deletion_otp_codes
                    SET used_at = now()
                  WHERE id = $1 AND used_at IS NULL`,
                [otp.id],
            );
            console.warn('[account.delete_confirm.failed]', {
                request_id: requestId, user_id: userId,
                phone_mask: phoneMask, reason: 'too_many_attempts',
            });
            return unauthorized('too_many_attempts', { origin });
        }

        const correct = verifyOtpCode(code, otp.code_hash);
        if (!correct) {
            await pool.query(
                `UPDATE private_data.account_deletion_otp_codes
                    SET attempts_count = attempts_count + 1
                  WHERE id = $1`,
                [otp.id],
            );
            console.warn('[account.delete_confirm.failed]', {
                request_id: requestId, user_id: userId,
                phone_mask: phoneMask, reason: 'wrong_code',
                attempts_remaining: Math.max(0, DELETION_OTP_MAX_ATTEMPTS - (otp.attempts_count + 1)),
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        // Атомарная пометка used_at — race-safe (как в /auth/verify).
        const marked = (await pool.query(
            `UPDATE private_data.account_deletion_otp_codes
                SET used_at = now()
              WHERE id = $1 AND used_at IS NULL
              RETURNING id`,
            [otp.id],
        )).rows;
        if (marked.length === 0) {
            console.warn('[account.delete_confirm.failed]', {
                request_id: requestId, user_id: userId,
                phone_mask: phoneMask, reason: 'race_lost',
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        // ─── Soft-delete: scheduled_at = now + 24h ──────────────────────────
        const scheduledAt = new Date(
            Date.now() + DELETION_GRACE_PERIOD_HOURS * 60 * 60 * 1000,
        );
        await pool.query(
            `UPDATE private_data.users
                SET deletion_requested_at = now(),
                    deletion_scheduled_at = $2
              WHERE id = $1 AND deletion_completed_at IS NULL`,
            [userId, scheduledAt.toISOString()],
        );

        // ─── Revoke всех активных сессий ────────────────────────────────────
        // Все, включая текущую — после ответа клиент получит 401 на
        // следующих запросах. Это намеренно (юзер не должен пользоваться
        // сервисом во время grace period — он удаляется).
        await pool.query(
            `UPDATE private_data.auth_sessions
                SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
        );

        // ─── Cancel активную подписку (если есть) ───────────────────────────
        await pool.query(
            `UPDATE private_data.subscriptions
                SET status         = 'cancelled',
                    cancelled_at   = now(),
                    next_charge_at = NULL
              WHERE user_id = $1 AND status = 'active'`,
            [userId],
        );

        // ─── Audit + уведомление ────────────────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.events_log (user_id, event_type)
             VALUES ($1, 'deletion_scheduled')`,
            [userId],
        );

        try {
            await notifyTransactional({
                user_id:    userId,
                kind:       'account_deletion_scheduled',
                params:     { scheduled_at: scheduledAt.toISOString() },
                request_id: requestId,
            }, { pool });
        } catch (err) {
            // Уведомление — best-effort. Если упадёт, основной soft-delete
            // всё равно совершился. Лог, продолжаем.
            console.error('[account.delete_confirm.notify_failed]', {
                request_id: requestId, user_id: userId, message: err?.message,
            });
        }

        console.log('[account.deletion_scheduled]', {
            request_id: requestId, user_id: userId,
            phone_mask: phoneMask,
            scheduled_at: scheduledAt.toISOString(),
        });

        return ok({
            deletion_scheduled_at: scheduledAt.toISOString(),
            grace_period_hours:    DELETION_GRACE_PERIOD_HOURS,
            message:               'Аккаунт будет удалён через 24 часа. Доступ к сервису прекращён.',
            cancel_url:            '/api/account/cancel-deletion',
        }, { origin });
    } catch (err) {
        console.error('[account.delete_confirm]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
