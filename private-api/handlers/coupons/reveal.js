// =============================================================================
// POST /api/coupons/{id}/reveal
//
// Авторизованный + ТРЕБУЕТ АКТИВНОЙ ПОДПИСКИ. Раскрывает полный код
// промокода пользователю и фиксирует факт раскрытия в coupon_reveals.
//
// Подписка считается «дающей доступ», если:
//   - status='active'                                  ИЛИ
//   - status='cancelled' AND expires_at > now()        (отыгрывает остаток)
//
// Повторный POST для того же (user, coupon) — idempotent через UNIQUE
// index + ON CONFLICT DO NOTHING. Запись в coupon_reveals не дублируется.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, forbidden, notFound, gone, methodNotAllowed,
    unauthorized, serverError, corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { parseCouponId } from '../../lib/event.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    let couponId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        // ─── 1. Парсинг coupon_id из path ────────────────────────────────────
        couponId = parseCouponId(event);
        if (couponId == null) return badRequest('invalid_coupon_id', { origin });

        // ─── 2. Проверка активной подписки ───────────────────────────────────
        const subs = (await pool.query(
            `SELECT id, status, expires_at
               FROM private_data.subscriptions
              WHERE user_id = $1
                AND status IN ('active', 'cancelled')
                AND (expires_at IS NULL OR expires_at > now())
              ORDER BY created_at DESC
              LIMIT 1`,
            [userId],
        )).rows[0];
        if (!subs) {
            return forbidden({
                error: 'subscription_required',
                message: 'Для раскрытия промокода нужна активная подписка',
                redirect_to: '/subscribe',
            }, { origin });
        }

        // ─── 3. SELECT coupon ────────────────────────────────────────────────
        const coupon = (await pool.query(
            `SELECT id, code, status, expires_at, confirmed_count, merchant_id
               FROM public_data.coupons
              WHERE id = $1`,
            [couponId],
        )).rows[0];
        if (!coupon) return notFound('coupon_not_found', { origin });
        if (coupon.status !== 'active') {
            return gone({ error: 'coupon_not_active', status: coupon.status }, { origin });
        }

        // ─── 4. INSERT в coupon_reveals (idempotent) ─────────────────────────
        await pool.query(
            `INSERT INTO private_data.coupon_reveals (user_id, coupon_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, coupon_id) DO NOTHING`,
            [userId, couponId],
        );

        console.log('[coupon.reveal]', {
            request_id: requestId, user_id: userId,
            coupon_id: couponId, merchant_id_hint: coupon.merchant_id,
        });

        return ok({
            code:            coupon.code,
            expires_at:      toIso(coupon.expires_at),
            confirmed_count: coupon.confirmed_count,
        }, { origin });
    } catch (err) {
        console.error('[coupon.reveal]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}

