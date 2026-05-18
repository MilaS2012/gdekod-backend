// =============================================================================
// POST /api/coupons/{id}/confirm
//
// Авторизованный (без проверки подписки). Голос «промокод работает».
//
// Защита: 1 голос (любого типа — confirm/complaint) на (user, coupon) в
// 24 часа. Cooldown проверяется через absolute timestamp (а не INTERVAL),
// чтобы стабильно работать в pg-mem.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, notFound, gone, methodNotAllowed,
    tooManyRequests, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { parseCouponId } from '../../lib/event.js';
import { VOTE_COOLDOWN_HOURS } from '../../lib/coupon-config.js';

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

        couponId = parseCouponId(event);
        if (couponId == null) return badRequest('invalid_coupon_id', { origin });

        // ─── coupon существует и активен? ────────────────────────────────────
        const coupon = (await pool.query(
            `SELECT id, status FROM public_data.coupons WHERE id = $1`,
            [couponId],
        )).rows[0];
        if (!coupon) return notFound('coupon_not_found', { origin });
        if (coupon.status !== 'active') {
            return gone({ error: 'coupon_not_active', status: coupon.status }, { origin });
        }

        // ─── Cooldown 24h на (user, coupon) — любой vote_type ────────────────
        const cooldownSince = new Date(Date.now() - VOTE_COOLDOWN_HOURS * 3600 * 1000);
        const prev = (await pool.query(
            `SELECT id, vote_type, created_at
               FROM private_data.coupon_votes
              WHERE user_id = $1 AND coupon_id = $2 AND created_at > $3
              ORDER BY created_at DESC
              LIMIT 1`,
            [userId, couponId, cooldownSince],
        )).rows[0];
        if (prev) {
            const nextAllowed = new Date(
                new Date(prev.created_at).getTime() + VOTE_COOLDOWN_HOURS * 3600 * 1000,
            );
            return tooManyRequests({
                error: 'too_many_votes',
                message: 'Вы уже голосовали за этот промокод. Следующий голос через 24 часа.',
                previous_vote: prev.vote_type,
                next_vote_allowed_at: toIso(nextAllowed),
            }, { origin });
        }

        // ─── INSERT vote + UPDATE счётчика ───────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.coupon_votes (user_id, coupon_id, vote_type)
             VALUES ($1, $2, 'confirm')`,
            [userId, couponId],
        );
        const updated = (await pool.query(
            `UPDATE public_data.coupons
                SET confirmed_count = confirmed_count + 1
              WHERE id = $1
              RETURNING confirmed_count`,
            [couponId],
        )).rows[0];

        console.log('[coupon.confirm]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            new_confirmed_count: updated.confirmed_count,
        });

        return ok({
            confirmed_count: updated.confirmed_count,
            your_vote:       'confirm',
        }, { origin });
    } catch (err) {
        console.error('[coupon.confirm]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
