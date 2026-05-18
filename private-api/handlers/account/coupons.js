// =============================================================================
// GET /api/account/coupons
//
// Авторизованный. Возвращает историю раскрытых пользователем промокодов
// с информацией о текущем состоянии coupon (статус, счётчики голосов).
//
// Если coupon удалён из public_data — возвращаем placeholder с status='removed',
// чтобы пользователь видел, что когда-то раскрывал его, но он недоступен.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')       return corsPreflight(origin);
    if (method && method !== 'GET') return methodNotAllowed(['GET', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const q = event?.queryStringParameters ?? {};
        const limit  = parseIntInRange(q.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = parseIntInRange(q.offset, 0,             0, 1_000_000);
        if (limit == null || offset == null) {
            return badRequest('invalid_pagination', { origin });
        }

        const rows = (await pool.query(
            `SELECT cr.id, cr.coupon_id, cr.revealed_at,
                    c.id AS c_id, c.merchant_id, c.description AS title,
                    c.code, c.discount, c.status, c.expires_at,
                    c.confirmed_count, c.complaint_count,
                    m.id AS m_id, m.name AS merchant_name,
                    m.logo_url, m.domain
               FROM private_data.coupon_reveals cr
               LEFT JOIN public_data.coupons   c ON c.id = cr.coupon_id
               LEFT JOIN public_data.merchants m ON m.id = c.merchant_id
              WHERE cr.user_id = $1
              ORDER BY cr.revealed_at DESC
              LIMIT $2 OFFSET $3`,
            [userId, limit, offset],
        )).rows;

        const total = (await pool.query(
            `SELECT count(*)::int AS c FROM private_data.coupon_reveals WHERE user_id = $1`,
            [userId],
        )).rows[0].c;

        const items = rows.map(r => ({
            revealed_at: toIso(r.revealed_at),
            coupon: r.c_id == null
                ? { id: r.coupon_id, status: 'removed', message: 'Промокод удалён' }
                : {
                    id:               r.c_id,
                    title:            r.title,
                    code:             r.code,
                    discount:         r.discount,
                    status:           r.status,
                    expires_at:       toIso(r.expires_at),
                    confirmed_count:  r.confirmed_count,
                    complaint_count:  r.complaint_count,
                    merchant: r.m_id != null ? {
                        id:       r.m_id,
                        name:     r.merchant_name,
                        slug:     domainToSlug(r.domain),
                        logo_url: r.logo_url,
                    } : null,
                },
        }));

        return ok({ items, total, limit, offset }, { origin });
    } catch (err) {
        console.error('[account.coupons]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}

function parseIntInRange(raw, defaultValue, min, max) {
    if (raw == null) return defaultValue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

function domainToSlug(domain) {
    if (typeof domain !== 'string' || domain.length === 0) return null;
    return domain.split('.')[0];
}
