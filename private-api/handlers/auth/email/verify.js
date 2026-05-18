// =============================================================================
// POST /api/auth/email/verify
//
// ПУБЛИЧНЫЙ endpoint — юзер кликает по ссылке из письма, фронт извлекает
// token из URL и шлёт сюда. requireUser НЕ применяется (юзер может быть
// в другом браузере, без сессии).
//
// Race-safe: атомарный UPDATE WHERE used_at IS NULL AND expires_at > now()
// RETURNING user_id, email. Единый 410 invalid_or_expired для трёх причин
// (не найден / истёк / уже использован).
//
// После пометки токена используем шаг 3: UPDATE users.email_verified_at,
// но С ДОПОЛНИТЕЛЬНОЙ ПРОВЕРКОЙ users.email = $email_из_токена. Это
// защита от race: пока юзер шёл по ссылке, он мог через другую сессию
// сменить email через /auth/email/attach. В таком случае verified
// не ставим, отвечаем тем же 410 (но в логе фиксируем email_mismatch).
//
// В ответе возвращаем только маскированный email — если злоумышленник
// прошёл по чужой ссылке, не должен узнать полный адрес жертвы.
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, gone, methodNotAllowed, serverError,
    corsPreflight, parseJsonBody, getOrigin,
} from '../../../lib/response.js';
import { maskEmail, maskToken } from '../../../lib/mask-pii.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{40,48}$/;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let tokenMaskForLog = '***';
    try {
        // ─── 1. Парсинг + валидация ──────────────────────────────────────────
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_token', { origin });
        const token = typeof body.token === 'string' ? body.token.trim() : null;
        if (!token || !TOKEN_RE.test(token)) {
            return badRequest('invalid_token', { origin });
        }
        tokenMaskForLog = maskToken(token);

        // ─── 2. Атомарная пометка used + получение user_id, email ────────────
        const claimed = (await pool.query(
            `UPDATE private_data.email_verify_tokens
                SET used_at = now()
              WHERE token = $1
                AND used_at IS NULL
                AND expires_at > now()
              RETURNING user_id, email`,
            [token],
        )).rows;
        if (claimed.length === 0) {
            console.warn('[auth.email.verify.failed]', {
                request_id: requestId, token_mask: tokenMaskForLog,
                reason: 'invalid_or_expired',
            });
            return gone('invalid_or_expired', { origin });
        }
        const { user_id: userId, email } = claimed[0];

        // ─── 3. Подтверждаем email с двойной проверкой совпадения ────────────
        // Если параллельно сменили email через /auth/email/attach — verified
        // НЕ ставим. Возвращаем тот же 410 (атакующий не должен различать).
        const updated = (await pool.query(
            `UPDATE private_data.users
                SET email_verified_at = now()
              WHERE id = $1 AND email = $2 AND email_verified_at IS NULL
              RETURNING id`,
            [userId, email],
        )).rows;
        if (updated.length === 0) {
            // Возможные причины: email уже сменили, или verified уже стоял
            // (теоретически не должен — мы только что использовали токен,
            // но защита от странных состояний).
            console.warn('[auth.email.verify.failed]', {
                request_id: requestId, token_mask: tokenMaskForLog,
                user_id: userId, reason: 'email_mismatch_or_already_verified',
            });
            return gone('invalid_or_expired', { origin });
        }

        // ─── 4. Аннулировать ВСЕ другие неиспользованные токены этого user ──
        // По §3.7.5 шаг 7 — одноразовость на уровне user_id, не только токена.
        await pool.query(
            `UPDATE private_data.email_verify_tokens
                SET used_at = now()
              WHERE user_id = $1 AND used_at IS NULL`,
            [userId],
        );

        console.log('[auth.email.verify.success]', {
            request_id: requestId,
            user_id:    userId,
            email_mask: maskEmail(email),
        });

        return ok({ verified: true, email_mask: maskEmail(email) }, { origin });
    } catch (err) {
        console.error('[auth.email.verify]', {
            request_id: requestId, token_mask: tokenMaskForLog, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
