// =============================================================================
// POST /api/account/delete-request
//
// Авторизованный. Шаг 1 удаления: отправка OTP-кода на phone user'а.
// Шаг 2 — подтверждение в /account/delete-confirm.
//
// ★ OTP отдельный (account_deletion_otp_codes), НЕ переиспользуется
//   логин-OTP. Тексты SMS разные:
//   - login:             «Код NNNN. Вводя его, вы регистрируетесь на ГдеКод...»
//   - account_deletion:  «Код для удаления аккаунта ГдеКод: NNNNNN.
//                          Если это не вы — игнорируйте.»
//
// ★ Rate-limits:
//   1. Базовый smsRateCheck по phone+IP (общая защита от спама SMS).
//   2. Доп. лимит на удаление: 1 запрос в час
//      (DELETION_REQUEST_RATE_LIMIT_PER_HOUR).
//
// ★ Защитные ветки:
//   - already_deleted (deletion_completed_at != NULL) → 410. На практике
//     эта ветка недостижима с валидной сессией (auth_sessions у такого
//     user'а удалены через CASCADE при DELETE FROM users), но проверяем
//     ради явной семантики.
//   - deletion_already_pending (deletion_scheduled_at != NULL) → 409
//     с deletion_scheduled_at и cancel-url подсказкой.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, conflict, gone, tooManyRequests, unauthorized,
    serverError, corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { smsRateCheck } from '../../lib/rate-limit.js';
import { generateOtpCode, hashOtpCode } from '../../lib/otp.js';
import { sendOtpSms } from '../../lib/sms-provider.js';
import { maskPhone, maskIp } from '../../lib/mask-pii.js';
import { extractIp } from '../../lib/event.js';
import {
    DELETION_OTP_TTL_SECONDS,
    DELETION_OTP_LENGTH,
    DELETION_REQUEST_RATE_LIMIT_PER_HOUR,
} from '../../lib/account-deletion-config.js';

const HOUR_MS = 60 * 60 * 1000;

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

        const ip = extractIp(event);

        // ─── Текущее состояние user'а ────────────────────────────────────────
        const user = (await pool.query(
            `SELECT id, phone, deletion_scheduled_at, deletion_completed_at
               FROM private_data.users
              WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!user) {
            console.error('[account.delete_request.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        if (user.deletion_completed_at != null) {
            // Защитная ветка: на практике сессия такого user'а уже revoked
            // и проверка requireUser упала бы. Но семантика лучше явная.
            return gone({ error: 'already_deleted' }, { origin });
        }
        if (user.deletion_scheduled_at != null) {
            return conflict({
                error: 'deletion_already_pending',
                deletion_scheduled_at: toIso(user.deletion_scheduled_at),
                cancel_url: '/api/account/cancel-deletion',
            }, { origin });
        }

        // ─── Дополнительный rate-limit: 1 запрос на удаление в час ──────────
        const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
        const recent = (await pool.query(
            `SELECT created_at
               FROM private_data.account_deletion_otp_codes
              WHERE user_id = $1 AND created_at > $2
              LIMIT $3`,
            [userId, hourAgo, DELETION_REQUEST_RATE_LIMIT_PER_HOUR],
        )).rows;
        if (recent.length >= DELETION_REQUEST_RATE_LIMIT_PER_HOUR) {
            console.warn('[account.delete_request.rate_limited]', {
                request_id: requestId, user_id: userId, reason: 'hourly_limit',
            });
            return tooManyRequests({
                error:   'too_many_delete_requests',
                message: 'Запрос на удаление можно отправлять не чаще 1 раза в час.',
            }, { origin });
        }

        // ─── Общий SMS rate-limit (защита от спама по phone+IP) ─────────────
        const smsRate = await smsRateCheck({ phone: user.phone, ip }, { pool });
        if (!smsRate.allowed) {
            return tooManyRequests('rate_limited', {
                origin,
                retryAfterSeconds: smsRate.retryAfterSeconds ?? null,
            });
        }

        // ─── Инвалидируем активный OTP-удаления (если был) ──────────────────
        // У account_deletion_otp_codes НЕТ partial unique, поэтому формально
        // INSERT нового пройдёт даже при активном предыдущем. Но мы
        // помечаем старый used_at=now() явно — чтобы delete-confirm нашёл
        // именно свежий код.
        await pool.query(
            `UPDATE private_data.account_deletion_otp_codes
                SET used_at = now()
              WHERE user_id = $1 AND used_at IS NULL`,
            [userId],
        );

        // ─── Генерация и хеширование ────────────────────────────────────────
        const code     = generateOtpCode(DELETION_OTP_LENGTH);
        const codeHash = hashOtpCode(code);
        const expiresAt = new Date(Date.now() + DELETION_OTP_TTL_SECONDS * 1000);

        await pool.query(
            `INSERT INTO private_data.account_deletion_otp_codes
               (user_id, code_hash, expires_at, ip_address)
             VALUES ($1, $2, $3, $4)`,
            [userId, codeHash, expiresAt, ip],
        );

        // ─── Отправка SMS (purpose='account_deletion' → отдельный шаблон) ──
        await sendOtpSms({
            phone:   user.phone,
            code,
            channel: 'sms',
            purpose: 'account_deletion',
        });

        console.log('[account.delete_request]', {
            request_id: requestId, user_id: userId,
            phone_mask: maskPhone(user.phone),
            ip_mask:    maskIp(ip),
        });

        return ok({
            otp_sent:           true,
            channel:            'sms',
            expires_in_seconds: DELETION_OTP_TTL_SECONDS,
        }, { origin });
    } catch (err) {
        console.error('[account.delete_request]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
