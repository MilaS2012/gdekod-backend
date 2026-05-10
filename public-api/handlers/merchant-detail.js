// =============================================================================
// GET /api/merchants/{id}
//
// Страница одного магазина: его поля + список активных промокодов.
// Реальные коды НЕ возвращаем — отдаём маску из mask-code.js.
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

        const pool = getPool();

        const merchSql = `
            SELECT id, name, slug, logo_url, category, created_at
            FROM public_data.merchants
            WHERE id = $1 AND is_active = true
        `;
        const merchRes = await pool.query(merchSql, [id]);
        if (merchRes.rows.length === 0) {
            return notFound('Merchant not found', { origin });
        }

        const couponsSql = `
            SELECT
                id,
                description AS title,
                discount,
                code,
                last_checked_at,
                expires_at,
                status
            FROM public_data.coupons
            WHERE merchant_id = $1 AND status = 'active'
            ORDER BY last_checked_at DESC NULLS LAST
        `;
        const couponsRes = await pool.query(couponsSql, [id]);

        const m = merchRes.rows[0];
        const merchant = {
            id:         Number(m.id),
            name:       m.name,
            slug:       m.slug,
            logo_url:   m.logo_url ?? null,
            category:   m.category,
            created_at: toIso(m.created_at),
            coupons: couponsRes.rows.map((c) => ({
                id:              Number(c.id),
                title:           c.title,
                discount:        c.discount,
                code:            maskCode(c.code),
                last_checked_at: toIso(c.last_checked_at),
                expires_at:      toIso(c.expires_at),
                status:          c.status,
            })),
        };

        return ok({ merchant }, { origin });

    } catch (err) {
        console.error('[merchant-detail]', { requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}
