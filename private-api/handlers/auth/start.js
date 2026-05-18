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
import { generateRandomToken } from '../../lib/tokens.js';
import { sendOtpSms } from '../../lib/sms-provider.js';
import { sendMagicLink } from '../../lib/email-provider.js';
import { maskPhone, maskIp } from '../../lib/mask-pii.js';
import { extractIp } from '../../lib/event.js';

const PHONE_RE = /^\+\d{10,15}$/;
const OTP_TTL_SECONDS         = 5 * 60;
const MAGIC_LINK_TTL_SECONDS  = 30 * 60;

// Подсказка фронту, какой UX показать. Содержит "что показать", а не
// "что произошло" — клиент не должен делать выводы вроде "user в БД есть".
const HINTS = Object.freeze({
    sms:        'check_sms_for_subscription_terms',
    magic_link: 'check_your_email',
    flash_call: 'enter_last_4_digits_of_incoming_call',
});

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

        // 5. Развилка по каналу:
        //   - !userExisted              → 'sms' (6 цифр, текст согласия на
        //                                  рекуррентную подписку — юридическое
        //                                  требование платёжных систем РФ)
        //   - existing + verified email → 'magic_link' (экономим на SMS)
        //   - existing без email        → 'flash_call' (4 цифры, экономим
        //                                  на SMS — текстовое согласие здесь
        //                                  не требуется, подписка уже оформлена)
        let channel;
        if (!userExisted)            channel = 'sms';
        else if (hasVerifiedEmail)   channel = 'magic_link';
        else                          channel = 'flash_call';

        if (channel === 'magic_link') {
            // ─── Magic link branch ───────────────────────────────────────────
            const emailRate = await emailRateCheck({ user_id: user.id }, { pool });
            if (!emailRate.allowed) {
                return tooManyRequests('rate_limited', {
                    origin,
                    retryAfterSeconds: emailRate.retryAfterSeconds ?? null,
                });
            }

            const token = generateRandomToken();
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
        } else {
            // ─── SMS (registration) или Flash Call (re-login) branch ─────────
            // Длина кода определяется каналом: OTP_LENGTH['sms'] = 6,
            // OTP_LENGTH['flash_call'] = 4.
            const code = generateOtpCode(OTP_LENGTH[channel]);
            const codeHash = hashOtpCode(code);
            const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

            await pool.query(
                `INSERT INTO private_data.otp_codes
                   (phone, code_hash, channel, expires_at, ip_address)
                 VALUES ($1, $2, $3, $4, $5)`,
                [phone, codeHash, channel, expiresAt, ip],
            );

            // channel передаём в провайдер, чтобы мок (а потом и реальный
            // SMS.ru) знал, какой текст отправлять: с условиями подписки
            // для 'sms', или короткий Flash Call.
            await sendOtpSms({ phone, code, channel });
        }

        const hint = HINTS[channel];

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

