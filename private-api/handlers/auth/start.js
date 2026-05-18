// =============================================================================
// POST /api/auth/start
//
// Точка входа в авторизацию: пользователь вводит номер телефона.
// Сервер решает, как доставлять OTP / magic link:
//   - email привязан И verified → magic_link (письмо на email)
//   - иначе                     → flash_call (звонок, последние 4 цифры)
// SMS используется как fallback на случай отказа Flash Call в этапе 6.3.5+.
//
// В этом handler'е НЕ возвращаем: код, токен, hash, факт существования
// пользователя. Это разведданные для атаки. Только channel + текстовый hint.
//
// Логи — структурированные, только с маскированным PII (maskPhone, maskIp).
// =============================================================================

import { getPool } from '../../lib/db.js';
import {
    ok, badRequest, methodNotAllowed, tooManyRequests, serverError,
    corsPreflight, parseJsonBody, getOrigin,
} from '../../lib/response.js';
import { smsRateCheck, emailRateCheck } from '../../lib/rate-limit.js';
import { generateOtpCode, hashOtpCode, OTP_LENGTH } from '../../lib/otp.js';
import { generateMagicLinkToken } from '../../lib/magic-link.js';
import { sendOtpSms } from '../../lib/sms-provider.js';
import { sendMagicLink } from '../../lib/email-provider.js';
import { maskPhone, maskIp } from '../../lib/mask-pii.js';
import { extractIp } from '../../lib/event.js';

const PHONE_RE = /^\+\d{10,15}$/;
const OTP_TTL_SECONDS         = 5 * 60;
const MAGIC_LINK_TTL_SECONDS  = 30 * 60;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    // CORS preflight / method check
    const method = event?.httpMethod;
    if (method === 'OPTIONS')         return corsPreflight(origin);
    if (method && method !== 'POST')  return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    try {
        // 1. Парсинг + валидация phone
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_json', { origin });
        const phone = typeof body.phone === 'string' ? body.phone.trim() : null;
        if (!phone || !PHONE_RE.test(phone)) {
            return badRequest('invalid_phone', { origin });
        }

        // 2. IP для rate-limit
        const ip = extractIp(event);

        // 3. Rate-limit (общий для всех каналов SMS/Flash Call/Voice)
        const smsRate = await smsRateCheck({ phone, ip }, { pool });
        if (!smsRate.allowed) {
            return tooManyRequests('rate_limited', {
                origin,
                retryAfterSeconds: smsRate.retryAfterSeconds ?? null,
            });
        }

        // 4. SELECT user, или создание если phone новый
        let user = (await pool.query(
            `SELECT id, email, email_verified_at
               FROM private_data.users
              WHERE phone = $1`,
            [phone],
        )).rows[0];
        const userExisted = !!user;
        if (!user) {
            user = (await pool.query(
                `INSERT INTO private_data.users (phone)
                 VALUES ($1)
                 RETURNING id, email, email_verified_at`,
                [phone],
            )).rows[0];
        }

        const hasVerifiedEmail = user.email != null && user.email_verified_at != null;

        // 5. Развилка по каналу
        let channel, hint;
        if (hasVerifiedEmail) {
            // ─── Magic link branch ───────────────────────────────────────────
            const emailRate = await emailRateCheck({ user_id: user.id }, { pool });
            if (!emailRate.allowed) {
                return tooManyRequests('rate_limited', {
                    origin,
                    retryAfterSeconds: emailRate.retryAfterSeconds ?? null,
                });
            }

            const token = generateMagicLinkToken();
            const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000);
            await pool.query(
                `INSERT INTO private_data.magic_link_tokens
                   (token, user_id, expires_at, ip_address)
                 VALUES ($1, $2, $3, $4)`,
                [token, user.id, expiresAt, ip],
            );

            await sendMagicLink({
                to: user.email,
                link: `https://gde-code.ru/auth/login-magic?token=${token}`,
                phoneMask: maskPhone(phone),
            });

            channel = 'magic_link';
            hint    = 'check_your_email';
        } else {
            // ─── Flash Call (OTP) branch ─────────────────────────────────────
            channel = 'flash_call';
            const code = generateOtpCode(OTP_LENGTH[channel]);
            const codeHash = hashOtpCode(code);
            const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

            await pool.query(
                `INSERT INTO private_data.otp_codes
                   (phone, code_hash, channel, expires_at, ip_address)
                 VALUES ($1, $2, $3, $4, $5)`,
                [phone, codeHash, channel, expiresAt, ip],
            );

            await sendOtpSms({ phone, code });

            hint = 'enter_last_4_digits_of_incoming_call';
        }

        console.log('[auth.start]', {
            request_id:    requestId,
            phone_mask:    maskPhone(phone),
            ip_mask:       maskIp(ip),
            channel,
            user_existed:  userExisted,
        });

        return ok({ channel, hint }, { origin });
    } catch (err) {
        console.error('[auth.start]', { request_id: requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}

