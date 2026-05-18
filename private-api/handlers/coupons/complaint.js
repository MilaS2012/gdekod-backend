// =============================================================================
// POST /api/coupons/{id}/complaint
//
// Авторизованный. Голос «промокод не работает». То же cooldown 24h, что
// и confirm — общий счётчик (один голос любого типа на coupon в сутки).
//
// ★ Триггеры по порогам (ТЗ §20.4 v16.1):
//   - complaint_count >= AUTO_EXPIRE (5)     → UPDATE status='expired'
//                                              (снимаем с витрины)
//   - complaint_count >= REPRIORITIZE (3)    → лог urgent_recheck для парсера
//                                              (он сам перепроверит в 6.8)
//   - complaint_count >= BLOCK_MERCHANT (10) → лог WARN, требует ручного
//                                              рассмотрения (НЕ блокируем
//                                              автоматически — слишком разрушительно)
//
// AUTO_EXPIRE срабатывает на ПЕРВОЙ жалобе, которая перешагнула порог.
// После status='expired' дальнейшие жалобы тоже инкрементируют счётчик
// (для аналитики), но триггер AUTO_EXPIRE — no-op (status уже expired).
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, notFound, gone, methodNotAllowed,
    tooManyRequests, unauthorized, serverError,
    corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../../lib/response.js';
import { parseCouponId } from '../../lib/event.js';
import { VOTE_COOLDOWN_HOURS, COMPLAINT_THRESHOLDS } from '../../lib/coupon-config.js';

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

        // Опциональная причина — не валидируем содержимое, только пишем в лог.
        const body   = parseJsonBody(event) ?? {};
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;

        const coupon = (await pool.query(
            `SELECT id, status, merchant_id FROM public_data.coupons WHERE id = $1`,
            [couponId],
        )).rows[0];
        if (!coupon) return notFound('coupon_not_found', { origin });
        if (coupon.status !== 'active') {
            return gone({ error: 'coupon_not_active', status: coupon.status }, { origin });
        }

        // Cooldown — общий счётчик с confirm.
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

        await pool.query(
            `INSERT INTO private_data.coupon_votes (user_id, coupon_id, vote_type)
             VALUES ($1, $2, 'complaint')`,
            [userId, couponId],
        );
        const updated = (await pool.query(
            `UPDATE public_data.coupons
                SET complaint_count   = complaint_count + 1,
                    last_complaint_at = now()
              WHERE id = $1
              RETURNING complaint_count, status, merchant_id`,
            [couponId],
        )).rows[0];

        const newCount = updated.complaint_count;
        let statusChanged = null;

        // ─── ТРИГГЕРЫ ПО ПОРОГАМ ─────────────────────────────────────────────
        if (newCount >= COMPLAINT_THRESHOLDS.BLOCK_MERCHANT) {
            // Просто WARN — НЕ автоматически блокируем магазин.
            console.warn('[coupon.merchant_block_threshold]', {
                request_id: requestId, coupon_id: couponId,
                merchant_id: updated.merchant_id, complaint_count: newCount,
                action_required: 'manual_review',
            });
        }
        if (newCount >= COMPLAINT_THRESHOLDS.AUTO_EXPIRE && updated.status === 'active') {
            // RACE-SAFE: два одновременных UPDATE'а status='active' → 'expired'
            // взаимоисключающие — только один пройдёт фильтр WHERE status='active',
            // второй получит 0 rows и не сделает ничего. Поэтому делаем
            // ОТДЕЛЬНЫМ UPDATE'ом после основного счётчика, а не в одном
            // UPDATE через CASE WHEN.
            const expired = (await pool.query(
                `UPDATE public_data.coupons
                    SET status = 'expired'
                  WHERE id = $1 AND status = 'active'
                  RETURNING status`,
                [couponId],
            )).rows[0];
            if (expired) {
                statusChanged = 'expired';
                console.warn('[coupon.auto_expired]', {
                    request_id: requestId, coupon_id: couponId,
                    complaint_count: newCount,
                });
            }
        } else if (newCount >= COMPLAINT_THRESHOLDS.REPRIORITIZE) {
            // Парсер прочитает coupons WHERE complaint_count >= 3 AND status='active'
            // в 6.8. Здесь — только лог-маркер.
            console.log('[coupon.urgent_recheck]', {
                request_id: requestId, coupon_id: couponId,
                complaint_count: newCount,
            });
        }

        console.log('[coupon.complaint]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            new_complaint_count: newCount, reason_provided: reason != null,
        });

        return ok({
            complaint_count: newCount,
            your_vote:       'complaint',
            status_changed:  statusChanged,
        }, { origin });
    } catch (err) {
        console.error('[coupon.complaint]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
