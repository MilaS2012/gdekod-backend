// =============================================================================
// POST /api/auth/email/attach
//
// Авторизованный (через requireUser). Юзер привязывает email — мы валидируем,
// генерируем токен подтверждения, отправляем письмо (через email-provider mock
// до подключения Yandex Postbox в 6.10).
//
// Состояния users.email:
//   ┌─────────────────────────────────┬───────────────────────────────────────┐
//   │ Текущее                         │ Реакция                               │
//   ├─────────────────────────────────┼───────────────────────────────────────┤
//   │ email IS NULL                   │ INSERT email, новый токен (new)       │
//   │ same email, verified            │ no-op, 200 already_verified           │
//   │ same email, NOT verified        │ старые токены→used, новый (replace)   │
//   │ different email, NOT verified   │ UPDATE email, новый токен (replace)   │
//   │ different email, verified       │ 409 already_verified_use_settings     │
//   └─────────────────────────────────┴───────────────────────────────────────┘
//
// Последний кейс (смена verified email) намеренно запрещён: в MVP нет
// /auth/email/detach. Если разрешить — атакующий с украденной сессией
// смог бы перепривязать email. Реальный flow смены email сделаем отдельной
// задачей с подтверждением через старый адрес.
// =============================================================================

import { getPool } from '../../../lib/db.js';
import { requireUser, AuthError } from '../../../lib/auth.js';
import {
    ok, badRequest, conflict, methodNotAllowed, tooManyRequests, serverError,
    unauthorized, corsPreflight, parseJsonBody, getOrigin,
} from '../../../lib/response.js';
import { emailAttachRateCheck } from '../../../lib/rate-limit.js';
import { generateRandomToken } from '../../../lib/tokens.js';
import { sendEmailVerify } from '../../../lib/email-provider.js';
import { maskEmail } from '../../../lib/mask-pii.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MIN_LEN = 5;
const EMAIL_MAX_LEN = 254;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;     // §3.7.5: 24 часа

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

        // ─── 2. Парсинг + валидация ──────────────────────────────────────────
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_email', { origin });
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
        if (!email
            || email.length < EMAIL_MIN_LEN
            || email.length > EMAIL_MAX_LEN
            || !EMAIL_RE.test(email)) {
            return badRequest('invalid_email', { origin });
        }
        emailForLog = email;

        // ─── 3. Rate-limit ───────────────────────────────────────────────────
        const rate = await emailAttachRateCheck({ user_id: userId }, { pool });
        if (!rate.allowed) {
            return tooManyRequests('rate_limited', {
                origin,
                retryAfterSeconds: rate.retryAfterSeconds ?? null,
            });
        }

        // ─── 4. Email уже у другого user? ────────────────────────────────────
        const taken = (await pool.query(
            `SELECT 1 FROM private_data.users WHERE email = $1 AND id != $2 LIMIT 1`,
            [email, userId],
        )).rows;
        if (taken.length > 0) {
            return conflict('email_taken', { origin });
        }

        // ─── 5. Текущее состояние email у этого user ─────────────────────────
        const self = (await pool.query(
            `SELECT email, email_verified_at FROM private_data.users WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!self) {
            // Логически невозможно (auth_session существует → user был)
            console.error('[auth.email.attach.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        const sameEmail = self.email === email;
        const verified  = self.email_verified_at != null;

        // 5a. Тот же email + уже verified — no-op, не тратим письмо.
        if (sameEmail && verified) {
            console.log('[auth.email.attach.noop]', {
                request_id: requestId, user_id: userId,
                email_mask: maskEmail(email), reason: 'already_verified',
            });
            return ok({ sent: false, already_verified: true }, { origin });
        }

        // 5b. Другой email, но текущий уже verified — запрещаем смену.
        // Объясняем юзеру, что делать (без этого месседжа будут писать
        // в саппорт «у вас всё сломано»).
        if (!sameEmail && verified) {
            console.warn('[auth.email.attach.rejected]', {
                request_id: requestId, user_id: userId,
                email_mask: maskEmail(email), reason: 'verified_email_already_attached',
            });
            return conflict({
                error: 'email_change_requires_old_email_confirmation',
                message: 'Изменение подтверждённого email требует подтверждения через старый email. Свяжись с поддержкой.',
            }, { origin });
        }

        // Определяем attempt: 'new' если ранее email не было, 'replace_unverified' иначе.
        const attempt = self.email == null ? 'new' : 'replace_unverified';

        // ─── 6. UPDATE users (новый или другой email; verified IS NULL уже) ──
        if (!sameEmail) {
            try {
                await pool.query(
                    `UPDATE private_data.users
                        SET email = $1, email_verified_at = NULL
                      WHERE id = $2`,
                    [email, userId],
                );
            } catch (err) {
                // Race с параллельным attach у другого user — partial unique violation.
                if (err?.code === '23505') {
                    return conflict('email_taken', { origin });
                }
                throw err;
            }
        }

        // ─── 7. Аннулировать все предыдущие неиспользованные токены этого user ─
        await pool.query(
            `UPDATE private_data.email_verify_tokens
                SET used_at = now()
              WHERE user_id = $1 AND used_at IS NULL`,
            [userId],
        );

        // ─── 8-9. Генерация + INSERT нового токена ────────────────────────────
        const token = generateRandomToken();
        const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
        await pool.query(
            `INSERT INTO private_data.email_verify_tokens
               (token, user_id, email, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [token, userId, email, expiresAt],
        );

        // ─── 10. Отправка письма ─────────────────────────────────────────────
        await sendEmailVerify({
            to:   email,
            link: `https://gde-code.ru/auth/email/verify?token=${token}`,
        });

        console.log('[auth.email.attach]', {
            request_id: requestId,
            user_id:    userId,
            email_mask: maskEmail(email),
            attempt,
        });

        return ok({ sent: true }, { origin });
    } catch (err) {
        console.error('[auth.email.attach]', {
            request_id: requestId,
            user_id:    userId,
            email_mask: emailForLog ? maskEmail(emailForLog) : null,
            message:    err?.message,
        });
        return serverError({ origin, requestId });
    }
}
