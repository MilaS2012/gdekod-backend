// =============================================================================
// POST /api/auth/verify
//
// Пользователь вводит OTP-код, полученный по flash_call/voice/SMS.
// Сервер проверяет → выпускает JWT и создаёт сессию.
//
// Контракт ответа: 200 { jwt }
//   Только JWT. session_id внутри payload (sid). Не дублируем поле в
//   ответе — это разведданные.
//
// Race-safe pattern (по согласованию 6.3.5, без BEGIN/COMMIT):
//   Шаг 5 — атомарный UPDATE ... WHERE id=$1 AND used_at IS NULL RETURNING ...
//   Если 0 rows — параллельный verify забрал OTP первым → 401.
//
// Документированное ограничение: если между UPDATE otp_codes (used_at=now)
// и INSERT auth_sessions произойдёт сетевой сбой — OTP помечен used,
// сессия не создана. Пользователь запросит новый код. Это редкий сбой,
// откат не делаем (мы не знаем, прошёл INSERT или нет — сбой мог быть
// на возврате ответа). См. тест 23.
// =============================================================================

import { getPool } from '../../lib/db.js';
import {
    ok, badRequest, unauthorized, methodNotAllowed, serverError,
    corsPreflight, parseJsonBody, getOrigin,
} from '../../lib/response.js';
import { verifyOtpCode } from '../../lib/otp.js';
import { signJwt } from '../../lib/jwt.js';
import { maskPhone, maskIp, maskToken } from '../../lib/mask-pii.js';
import { extractIp, extractUserAgent, userAgentHash, parseUserAgent } from '../../lib/event.js';

const PHONE_RE = /^\+\d{10,15}$/;
const CODE_RE  = /^(?:\d{4}|\d{6})$/;     // 4 для flash_call/voice, 6 для sms — ровно эти длины
const MAX_ATTEMPTS = 5;
const SESSION_TTL_DAYS = 90;              // ТЗ §3.6

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let phone = null;
    try {
        // ─── 1. Парсинг + валидация ───────────────────────────────────────────
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });
        phone      = typeof body.phone === 'string' ? body.phone.trim() : null;
        const code = typeof body.code  === 'string' ? body.code.trim()  : null;
        if (!phone || !PHONE_RE.test(phone)) return badRequest('invalid_input', { origin });
        if (!code  || !CODE_RE.test(code))   return badRequest('invalid_input', { origin });

        const phoneMask = maskPhone(phone);

        // ─── 2. SELECT активного OTP ─────────────────────────────────────────
        const otp = (await pool.query(
            `SELECT id, code_hash, channel, expires_at, attempts_count
               FROM private_data.otp_codes
              WHERE phone = $1
                AND used_at IS NULL
                AND expires_at > now()
              ORDER BY created_at DESC
              LIMIT 1`,
            [phone],
        )).rows[0];

        if (!otp) {
            console.warn('[auth.verify.failed]', {
                request_id: requestId, phone_mask: phoneMask, reason: 'no_active_otp',
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        // ─── 3. Brute-force защита (attempts ≥ MAX) ──────────────────────────
        if (otp.attempts_count >= MAX_ATTEMPTS) {
            // Гасим OTP, чтобы не било больше.
            await pool.query(
                `UPDATE private_data.otp_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
                [otp.id],
            );
            console.warn('[auth.verify.failed]', {
                request_id: requestId, phone_mask: phoneMask, reason: 'too_many_attempts',
            });
            return unauthorized('too_many_attempts', { origin });
        }

        // ─── 4. Constant-time сравнение ──────────────────────────────────────
        const correct = verifyOtpCode(code, otp.code_hash);
        if (!correct) {
            await pool.query(
                `UPDATE private_data.otp_codes SET attempts_count = attempts_count + 1 WHERE id = $1`,
                [otp.id],
            );
            const remaining = Math.max(0, MAX_ATTEMPTS - (otp.attempts_count + 1));
            console.warn('[auth.verify.failed]', {
                request_id: requestId, phone_mask: phoneMask,
                reason: 'wrong_code', attempts_remaining: remaining,
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        // ─── 5. Атомарная пометка used_at (race-safe) ────────────────────────
        const marked = (await pool.query(
            `UPDATE private_data.otp_codes
                SET used_at = now()
              WHERE id = $1 AND used_at IS NULL
              RETURNING phone`,
            [otp.id],
        )).rows;
        if (marked.length === 0) {
            // Параллельный verify забрал OTP первым — race lost.
            console.warn('[auth.verify.failed]', {
                request_id: requestId, phone_mask: phoneMask, reason: 'race_lost',
            });
            return unauthorized('invalid_or_expired', { origin });
        }

        // ─── 6. SELECT user (создан в /auth/start) ───────────────────────────
        const user = (await pool.query(
            `SELECT id FROM private_data.users WHERE phone = $1`,
            [phone],
        )).rows[0];
        if (!user) {
            // Аномалия: OTP без user. /auth/start создаёт user перед OTP,
            // такое не должно случаться. Логируем как error.
            console.error('[auth.verify.anomaly]', {
                request_id: requestId, phone_mask: phoneMask, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        // ─── 7. INSERT auth_sessions (атомарно с RETURNING) ──────────────────
        const ip        = extractIp(event);
        const ua        = extractUserAgent(event);
        const uaHash    = userAgentHash(ua);
        const uaSummary = parseUserAgent(ua);
        const expires   = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);

        let session;
        try {
            session = (await pool.query(
                `INSERT INTO private_data.auth_sessions
                   (user_id, expires_at, ip_address, user_agent_hash, user_agent_summary)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING session_id`,
                [user.id, expires, ip, uaHash, uaSummary],
            )).rows[0];
        } catch (err) {
            // OTP уже used_at = now(), сессии нет. Откатывать OTP не пытаемся
            // (см. шапку файла). Юзер запросит новый код.
            console.error('[auth.verify.session_creation_failed]', {
                request_id: requestId, phone_mask: phoneMask,
                user_id: user.id, message: err?.message,
            });
            return serverError({ origin, requestId });
        }

        // ─── 8. Подпись JWT ──────────────────────────────────────────────────
        const jwt = await signJwt({ sub: user.id, sid: session.session_id });

        console.log('[auth.verify.success]', {
            request_id: requestId,
            phone_mask: phoneMask,
            ip_mask:    maskIp(ip),
            channel:    otp.channel,
            user_id:    user.id,
            sid_mask:   maskToken(session.session_id),
        });

        return ok({ jwt }, { origin });
    } catch (err) {
        console.error('[auth.verify]', {
            request_id: requestId,
            phone_mask: phone ? maskPhone(phone) : null,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
