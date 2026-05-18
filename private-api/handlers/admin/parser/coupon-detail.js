// =============================================================================
// GET /api/admin/parser/coupon/{id}
//
// Защита: X-Parser-Secret. Полная информация о coupon для парсера —
// включая все парсер-поля (last_parse_status, last_parse_error и т.д.).
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, notFound, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../../lib/response.js';
import { parseCouponId } from '../../../lib/event.js';
import { requireParserSecret, ParserAuthError } from '../../../lib/parser-auth.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')       return corsPreflight(origin);
    if (method && method !== 'GET') return methodNotAllowed(['GET', 'OPTIONS'], { origin });

    try {
        try { requireParserSecret(event); }
        catch (e) {
            if (e instanceof ParserAuthError) return unauthorized('invalid_parser_secret', { origin });
            throw e;
        }

        const couponId = parseCouponId(event);
        if (couponId == null) return badRequest('invalid_coupon_id', { origin });

        const row = (await pool.query(
            `SELECT c.id, c.merchant_id, c.tier, c.status,
                    c.description, c.discount, c.code, c.expires_at, c.created_at,
                    c.last_checked_at, c.last_successful_check_at,
                    c.last_parse_status, c.last_parse_error,
                    c.confirmed_count, c.complaint_count, c.last_complaint_at,
                    m.id AS m_id, m.name AS merchant_name,
                    m.domain, m.logo_url, m.category,
                    split_part(m.domain, '.', 1) AS merchant_slug
               FROM public_data.coupons c
               LEFT JOIN public_data.merchants m ON m.id = c.merchant_id
              WHERE c.id = $1`,
            [couponId],
        )).rows[0];
        if (!row) return notFound('coupon_not_found', { origin });

        console.log('[parser.coupon_detail]', {
            request_id: requestId, coupon_id: couponId,
        });

        return ok({
            coupon: {
                id:                       row.id,
                merchant_id:              row.merchant_id,
                tier:                     row.tier,
                status:                   row.status,
                description:              row.description,
                discount:                 row.discount,
                code:                     row.code,
                expires_at:               toIso(row.expires_at),
                created_at:               toIso(row.created_at),
                last_checked_at:          toIso(row.last_checked_at),
                last_successful_check_at: toIso(row.last_successful_check_at),
                last_parse_status:        row.last_parse_status,
                last_parse_error:         row.last_parse_error,
                votes: {
                    confirmed:        row.confirmed_count,
                    complaint:        row.complaint_count,
                    last_complaint_at: toIso(row.last_complaint_at),
                },
                merchant: row.m_id != null ? {
                    id:       row.m_id,
                    name:     row.merchant_name,
                    slug:     row.merchant_slug,
                    domain:   row.domain,
                    logo_url: row.logo_url,
                    category: row.category,
                } : null,
            },
        }, { origin });
    } catch (err) {
        console.error('[parser.coupon_detail]', {
            request_id: requestId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
