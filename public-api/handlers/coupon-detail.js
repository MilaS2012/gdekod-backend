// =============================================================================
// GET /api/coupons/{id}
//
// Карточка одного промокода для гостя. code замаскирован.
// =============================================================================

import { getPool } from '../lib/db.js';
import {
    ok, badRequest, notFound, methodNotAllowed, serverError, corsPreflight,
    getOrigin, toIso,
} from '../lib/response.js';
import { maskCode } from '../lib/mask-code.js';

export async function handler(event, context) {
    const origin = getOrigin(event);
    const requestId = context?.requestId ?? null;

    try {
        const method = event?.httpMethod ?? 'GET';
        if (method === 'OPTIONS') return corsPreflight(origin);
        if (method !== 'GET')      return methodNotAllowed({ origin });

        const rawId = event?.pathParameters?.id ?? event?.params?.id ?? null;
        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0) {
            return badRequest('Invalid id', { origin });
        }

        // merchant_slug: пока в схеме нет колонки slug, выводим первую
        // часть домена. После миграции public_data — заменить на m.slug.
        const sql = `
            SELECT
                c.id,
                c.description AS title,
                c.discount,
                c.code,
                c.last_checked_at,
                c.expires_at,
                c.status,
                m.id                              AS merchant_id,
                m.name                            AS merchant_name,
                split_part(m.domain, '.', 1)      AS merchant_slug,
                m.logo_url                        AS merchant_logo_url,
                m.category                        AS merchant_category
            FROM public_data.coupons c
            JOIN public_data.merchants m ON m.id = c.merchant_id
            WHERE c.id = $1 AND c.status = 'active' AND m.is_active = true
        `;
        const { rows } = await getPool().query(sql, [id]);
        if (rows.length === 0) {
            return notFound('Coupon not found', { origin });
        }

        const r = rows[0];
        const coupon = {
            id:              Number(r.id),
            title:           r.title,
            discount:        r.discount,
            code:            maskCode(r.code),
            last_checked_at: toIso(r.last_checked_at),
            expires_at:      toIso(r.expires_at),
            status:          r.status,
            merchant: {
                id:       Number(r.merchant_id),
                name:     r.merchant_name,
                slug:     r.merchant_slug,
                logo_url: r.merchant_logo_url ?? null,
                category: r.merchant_category,
            },
        };

        return ok({ coupon }, { origin });

    } catch (err) {
        console.error('[coupon-detail]', { requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}
