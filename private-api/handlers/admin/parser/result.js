// =============================================================================
// POST /api/admin/parser/result
//
// Защита: X-Parser-Secret.
//
// Парсер шлёт результат проверки одного coupon. Бэкенд обновляет
// public_data.coupons в зависимости от status:
//   - active        → last_checked_at + last_successful_check_at + опц. поля
//   - expired       → status='expired' (race-safe: WHERE status='active')
//   - invalid       → как expired (для пользователя одно и то же)
//   - not_found     → как expired + WARN-лог (магазин мог закрыться)
//   - parsing_error → status НЕ меняется, last_parse_error + WARN-лог
//
// Идемпотентность: повторный /result для уже expired coupon не падает —
// race-safe UPDATE с фильтром status='active' просто пропускает.
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, notFound, methodNotAllowed, unauthorized, serverError,
    corsPreflight, parseJsonBody, getOrigin,
} from '../../../lib/response.js';
import { requireParserSecret, ParserAuthError } from '../../../lib/parser-auth.js';
import { PARSE_RESULT_STATUSES } from '../../../lib/parser-config.js';

const MAX_ERROR_TEXT_LEN = 1000;
const MAX_CODE_LEN       = 128;     // = VARCHAR(128) для coupons.code в 001
const MAX_DISCOUNT_LEN   = 64;      // = VARCHAR(64) для coupons.discount

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let couponId = null;
    let status = null;
    try {
        try { requireParserSecret(event); }
        catch (e) {
            if (e instanceof ParserAuthError) return unauthorized('invalid_parser_secret', { origin });
            throw e;
        }

        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });

        couponId = Number(body.coupon_id);
        if (!Number.isInteger(couponId) || couponId <= 0) {
            return badRequest('invalid_coupon_id', { origin });
        }
        status = typeof body.status === 'string' ? body.status : null;
        if (!status || !PARSE_RESULT_STATUSES.includes(status)) {
            return badRequest('invalid_status', { origin });
        }
        const errorText   = trimOrNull(body.error_text,   MAX_ERROR_TEXT_LEN, 'error_text',  couponId, requestId);
        const newCode     = trimOrNull(body.new_code,     MAX_CODE_LEN,       'code',        couponId, requestId);
        const newDiscount = trimOrNull(body.new_discount, MAX_DISCOUNT_LEN,   'discount',    couponId, requestId);
        const newExpiresAt = parseDate(body.new_expires_at);

        // Coupon существует?
        const existing = (await pool.query(
            `SELECT id, status FROM public_data.coupons WHERE id = $1`,
            [couponId],
        )).rows[0];
        if (!existing) return notFound('coupon_not_found', { origin });

        // Применяем по status
        let newCouponStatus = existing.status;

        if (status === 'active') {
            await pool.query(
                `UPDATE public_data.coupons
                    SET last_checked_at          = now(),
                        last_successful_check_at = now(),
                        last_parse_status        = 'active',
                        last_parse_error         = NULL,
                        code       = COALESCE($2, code),
                        discount   = COALESCE($3, discount),
                        expires_at = COALESCE($4, expires_at)
                  WHERE id = $1`,
                [couponId, newCode, newDiscount, newExpiresAt],
            );
            console.log('[parser.result]', {
                request_id: requestId, coupon_id: couponId, status: 'active',
            });
        } else if (status === 'expired' || status === 'invalid') {
            // Race-safe: только переводим active → expired. Если уже не active
            // (auto-expire от жалоб в 6.7 или параллельный /result) — пропуск.
            const r = (await pool.query(
                `UPDATE public_data.coupons
                    SET status            = 'expired',
                        last_checked_at   = now(),
                        last_parse_status = $2
                  WHERE id = $1 AND status = 'active'
                  RETURNING status`,
                [couponId, status],
            )).rows[0];
            if (r) newCouponStatus = r.status;
            // Если 0 rows — всё равно надо обновить last_checked_at, чтобы
            // парсер не дёргал coupon в цикле; делаем отдельным UPDATE без
            // изменения status.
            else {
                await pool.query(
                    `UPDATE public_data.coupons
                        SET last_checked_at   = now(),
                            last_parse_status = $2
                      WHERE id = $1`,
                    [couponId, status],
                );
            }
            console.log('[parser.coupon_expired]', {
                request_id: requestId, coupon_id: couponId, status,
            });
        } else if (status === 'not_found') {
            const r = (await pool.query(
                `UPDATE public_data.coupons
                    SET status            = 'expired',
                        last_checked_at   = now(),
                        last_parse_status = 'not_found'
                  WHERE id = $1 AND status = 'active'
                  RETURNING status`,
                [couponId],
            )).rows[0];
            if (r) newCouponStatus = r.status;
            else {
                await pool.query(
                    `UPDATE public_data.coupons
                        SET last_checked_at   = now(),
                            last_parse_status = 'not_found'
                      WHERE id = $1`,
                    [couponId],
                );
            }
            console.warn('[parser.not_found]', {
                request_id: requestId, coupon_id: couponId,
                note: 'merchant page returned 404 — возможно редизайн/закрытие',
            });
        } else if (status === 'parsing_error') {
            // status НЕ меняем — это техническая ошибка, не значит «код плохой».
            await pool.query(
                `UPDATE public_data.coupons
                    SET last_checked_at   = now(),
                        last_parse_status = 'parsing_error',
                        last_parse_error  = $2
                  WHERE id = $1`,
                [couponId, errorText],
            );
            console.warn('[parser.parsing_error]', {
                request_id: requestId, coupon_id: couponId,
                error_excerpt: truncate(errorText, 200),
            });
        }

        return ok({
            ok:         true,
            coupon_id:  couponId,
            new_status: newCouponStatus,
            updated_at: new Date().toISOString(),
        }, { origin });
    } catch (err) {
        console.error('[parser.result]', {
            request_id: requestId, coupon_id: couponId, status,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}

function trimOrNull(value, maxLen, fieldName, couponId, requestId) {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    if (t.length === 0) return null;
    if (t.length > maxLen) {
        // Парсер прислал слишком длинное значение — обрезаем, но логируем
        // как WARN для отладки. Это сигнал что магазин сломался или парсер
        // плохо парсит.
        console.warn('[parser.field_truncated]', {
            request_id: requestId, coupon_id: couponId, field: fieldName,
            original_length: t.length, truncated_to: maxLen,
        });
        return t.slice(0, maxLen);
    }
    return t;
}

function parseDate(raw) {
    if (raw == null) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

function truncate(s, len) {
    if (typeof s !== 'string') return null;
    return s.length > len ? s.slice(0, len) + '…' : s;
}
