// =============================================================================
// GET /api/coupons
//
// Публичный список промокодов с пагинацией.
//   ?merchant_id=  — опциональный фильтр по магазину
//   ?category=     — опциональный фильтр по категории магазина
//   ?limit=20      — 1..100, default 20
//   ?offset=0      — default 0
// Сортировка: по last_checked_at DESC (свежее — выше).
//
// code в ответе всегда замаскирован (XXXX-XXXX). Реальный код — только
// в защищённом /api/coupons/{id}/code (этап 6).
// =============================================================================

import { getPool } from '../lib/db.js';
import {
    ok, badRequest, methodNotAllowed, serverError, corsPreflight,
    getOrigin, toIso,
} from '../lib/response.js';
import { maskCode } from '../lib/mask-code.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;
const MAX_OFFSET    = 1_000_000;

function parseIntParam(raw, min, max, def) {
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

export async function handler(event, context) {
    const origin = getOrigin(event);
    const requestId = context?.requestId ?? null;

    try {
        const method = event?.httpMethod ?? 'GET';
        if (method === 'OPTIONS') return corsPreflight(origin);
        if (method !== 'GET')      return methodNotAllowed({ origin });

        const q = event?.queryStringParameters ?? {};

        const limit = parseIntParam(q.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
        if (limit === null) {
            return badRequest(`Invalid limit (1..${MAX_LIMIT})`, { origin });
        }
        const offset = parseIntParam(q.offset, 0, MAX_OFFSET, 0);
        if (offset === null) {
            return badRequest(`Invalid offset (0..${MAX_OFFSET})`, { origin });
        }

        let merchantId = null;
        if (q.merchant_id != null && q.merchant_id !== '') {
            const parsed = Number(q.merchant_id);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                return badRequest('Invalid merchant_id', { origin });
            }
            merchantId = parsed;
        }

        const category = q.category ?? null;

        // Собираем WHERE
        const conditions = ["c.status = 'active'", 'm.is_active = true'];
        const params = [];
        if (merchantId !== null) {
            params.push(merchantId);
            conditions.push(`c.merchant_id = $${params.length}`);
        }
        if (category) {
            params.push(category);
            conditions.push(`m.category = $${params.length}`);
        }
        const where = conditions.join(' AND ');

        const pool = getPool();

        // 1. Total для UI пагинации
        const countSql = `
            SELECT COUNT(*)::bigint AS total
            FROM public_data.coupons c
            JOIN public_data.merchants m ON m.id = c.merchant_id
            WHERE ${where}
        `;
        const countRes = await pool.query(countSql, params);
        const total = Number(countRes.rows[0]?.total ?? 0);

        // 2. Страница
        const limitParam  = `$${params.length + 1}`;
        const offsetParam = `$${params.length + 2}`;
        // merchant_slug: пока в схеме нет колонки slug, выводим первую
        // часть домена. После миграции public_data — заменить на m.slug.
        const listSql = `
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
            WHERE ${where}
            ORDER BY c.last_checked_at DESC NULLS LAST
            LIMIT ${limitParam} OFFSET ${offsetParam}
        `;
        const listRes = await pool.query(listSql, [...params, limit, offset]);

        const coupons = listRes.rows.map((r) => ({
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
        }));

        return ok({ coupons, total, limit, offset }, { origin });

    } catch (err) {
        console.error('[coupons-list]', { requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}
