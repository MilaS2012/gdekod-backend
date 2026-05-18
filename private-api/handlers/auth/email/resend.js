// =============================================================================
// POST /api/auth/email/resend
//
// Авторизованный. Повторно отправляет письмо подтверждения на email,
// который юзер уже привязал, но не подтвердил.
//
// Использует тот же счётчик rate-limit, что и /auth/email/attach
// (emailAttachRateCheck по email_verify_tokens) — суммарный лимит
// 5 писем в сутки на привязку.
// =============================================================================

import { getPool } from '../../../lib/db.js';
import { requireUser, AuthError } from '../../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, tooManyRequests, serverError,
    unauthorized, corsPreflight, getOrigin,
} from '../../../lib/response.js';
import { emailAttachRateCheck } from '../../../lib/rate-limit.js';
import { generateRandomToken } from '../../../lib/tokens.js';
import { sendEmailVerify } from '../../../lib/email-provider.js';
import { maskEmail } from '../../../lib/mask-pii.js';

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    let emailForLog = null;
    try {
        // ─── 1. requireUser ──────────────────────────────────────────────────
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        // ─── 2. Текущее состояние email ──────────────────────────────────────
        const self = (await pool.query(
            `SELECT email, email_verified_at FROM private_data.users WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!self) {
            console.error('[auth.email.resend.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }
        if (!self.email) {
            return badRequest('no_email_attached', { origin });
        }
        emailForLog = self.email;

        if (self.email_verified_at != null) {
            console.log('[auth.email.resend.noop]', {
                request_id: requestId, user_id: userId,
                email_mask: maskEmail(self.email), reason: 'already_verified',
            });
            return ok({ sent: false, already_verified: true }, { origin });
        }

        // ─── 3. Rate-limit (общий счётчик с attach) ──────────────────────────
        const rate = await emailAttachRateCheck({ user_id: userId }, { pool });
        if (!rate.allowed) {
            return tooManyRequests('rate_limited', {
                origin,
                retryAfterSeconds: rate.retryAfterSeconds ?? null,
            });
        }

        // ─── 4. Аннулировать предыдущие токены ───────────────────────────────
        await pool.query(
            `UPDATE private_data.email_verify_tokens
                SET used_at = now()
              WHERE user_id = $1 AND used_at IS NULL`,
            [userId],
        );

        // ─── 5. Новый токен + INSERT ─────────────────────────────────────────
        const token = generateRandomToken();
        const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
        await pool.query(
            `INSERT INTO private_data.email_verify_tokens
               (token, user_id, email, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [token, userId, self.email, expiresAt],
        );

        // ─── 6. Отправка письма ──────────────────────────────────────────────
        await sendEmailVerify({
            to:   self.email,
            link: `https://gde-code.ru/auth/email/verify?token=${token}`,
        });

        console.log('[auth.email.resend]', {
            request_id: requestId,
            user_id:    userId,
            email_mask: maskEmail(self.email),
        });

        return ok({ sent: true }, { origin });
    } catch (err) {
        console.error('[auth.email.resend]', {
            request_id: requestId,
            user_id:    userId,
            email_mask: emailForLog ? maskEmail(emailForLog) : null,
            message:    err?.message,
        });
        return serverError({ origin, requestId });
    }
}
