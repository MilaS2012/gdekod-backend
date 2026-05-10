// =============================================================================
// GET /api/merchants
//
// Список активных магазинов с количеством действующих промокодов.
// Магазины без активных промокодов скрываются (HAVING coupons_count > 0).
//
// Query params:
//   ?category=eda    — опциональный фильтр по категории.
// =============================================================================

import { getPool } from '../lib/db.js';
import {
    ok, methodNotAllowed, serverError, corsPreflight, getOrigin,
} from '../lib/response.js';

export async function handler(event, context) {
    const origin = getOrigin(event);
    const requestId = context?.requestId ?? null;

    try {
        const method = event?.httpMethod ?? 'GET';
        if (method === 'OPTIONS') return corsPreflight(origin);
        if (method !== 'GET')      return methodNotAllowed({ origin });

        const category = event?.queryStringParameters?.category ?? null;

        const params = [];
        let extraWhere = '';
        if (category) {
            params.push(category);
            extraWhere = ` AND m.category = $${params.length}`;
        }

        const sql = `
            SELECT
                m.id,
                m.name,
                m.slug,
                m.logo_url,
                m.category,
                COUNT(c.id) FILTER (WHERE c.status = 'active') AS coupons_count
            FROM public_data.merchants m
            LEFT JOIN public_data.coupons c ON c.merchant_id = m.id
            WHERE m.is_active = true${extraWhere}
            GROUP BY m.id, m.name, m.slug, m.logo_url, m.category
            HAVING COUNT(c.id) FILTER (WHERE c.status = 'active') > 0
            ORDER BY m.name
        `;

        const { rows } = await getPool().query(sql, params);

        const merchants = rows.map((r) => ({
            id:            Number(r.id),
            name:          r.name,
            slug:          r.slug,
            logo_url:      r.logo_url ?? null,
            category:      r.category,
            // pg отдаёт COUNT() как BIGINT-строку → приводим к числу
            coupons_count: Number(r.coupons_count),
        }));

        return ok({ merchants }, { origin });

    } catch (err) {
        console.error('[merchants-list]', { requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}
