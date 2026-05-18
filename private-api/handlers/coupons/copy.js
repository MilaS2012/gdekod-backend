// =============================================================================
// POST /api/coupons/{id}/copy
//
// Авторизованный (БЕЗ проверки подписки — нужен только лог факта копирования
// кода в буфер обмена для аналитики).
//
// Сейчас просто логирует — таблица events_log появится в 6.11, тогда
// эта же логика будет писать туда же.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin,
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

        couponId = parseCouponId(event);
        if (couponId == null) return badRequest('invalid_coupon_id', { origin });

        // Простой лог. В 6.11 заменим на INSERT в events_log.
        console.log('[coupon.copy]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
        });

        return ok({ ok: true }, { origin });
    } catch (err) {
        console.error('[coupon.copy]', {
            request_id: requestId, user_id: userId, coupon_id: couponId,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
