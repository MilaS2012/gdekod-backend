// =============================================================================
// GET /api/admin/parser/coupons?tier=N&limit=N&offset=N
//
// Защита: X-Parser-Secret (backend-to-backend, без JWT).
//
// Возвращает coupons заданного tier, которым «пора перепровериться» —
// last_checked_at IS NULL ИЛИ < (now - TIER_INTERVALS_HOURS[tier]).
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../../lib/response.js';
import { requireParserSecret, ParserAuthError } from '../../../lib/parser-auth.js';
import { TIER_INTERVALS_HOURS, VALID_TIERS } from '../../../lib/parser-config.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

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

        const q = event?.queryStringParameters ?? {};
        const tier   = parseTier(q.tier);
        const limit  = parseIntInRange(q.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = parseIntInRange(q.offset, 0,             0, 1_000_000);
        if (tier == null)   return badRequest('invalid_tier',   { origin });
        if (limit == null)  return badRequest('invalid_limit',  { origin });
        if (offset == null) return badRequest('invalid_offset', { origin });

        const intervalHours = TIER_INTERVALS_HOURS[tier];
        // Absolute timestamp — стабильно работает в pg-mem (INTERVAL с
        // параметром $::interval — не поддерживается).
        const cutoff = new Date(Date.now() - intervalHours * 3600 * 1000).toISOString();

        const rows = (await pool.query(
            `SELECT c.id, c.merchant_id, c.tier, c.status,
                    c.description, c.discount, c.code, c.expires_at,
                    c.last_checked_at, c.last_successful_check_at,
                    c.last_parse_status,
                    c.confirmed_count, c.complaint_count,
                    m.id AS m_id, m.name AS merchant_name, m.domain,
                    split_part(m.domain, '.', 1) AS merchant_slug
               FROM public_data.coupons c
               LEFT JOIN public_data.merchants m ON m.id = c.merchant_id
              WHERE c.status = 'active'
                AND c.tier   = $1
                AND (c.last_checked_at IS NULL OR c.last_checked_at < $2::timestamptz)
              ORDER BY c.last_checked_at NULLS FIRST, c.confirmed_count DESC
              LIMIT $3 OFFSET $4`,
            [tier, cutoff, limit, offset],
        )).rows;

        const total = (await pool.query(
            `SELECT count(*)::int AS c
               FROM public_data.coupons
              WHERE status = 'active'
                AND tier   = $1
                AND (last_checked_at IS NULL OR last_checked_at < $2::timestamptz)`,
            [tier, cutoff],
        )).rows[0].c;

        const items = rows.map(r => mapCoupon(r));

        console.log('[parser.coupons_list]', {
            request_id: requestId, tier, count: items.length, total,
        });

        return ok({ items, total, tier, limit, offset }, { origin });
    } catch (err) {
        console.error('[parser.coupons_list]', { request_id: requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}

function parseTier(raw) {
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || !VALID_TIERS.includes(n)) return null;
    return n;
}
function parseIntInRange(raw, def, min, max) {
    if (raw == null) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}
// ★ Также используется в urgent-queue.js — экспортируем.
// Требует от SELECT'а row.merchant_slug (через split_part в SQL,
// как public-api/handlers/*.js делают для консистентности).
export function mapCoupon(r) {
    return {
        id:                       r.id,
        tier:                     r.tier,
        status:                   r.status,
        description:              r.description,
        discount:                 r.discount,
        code:                     r.code,
        expires_at:               toIso(r.expires_at),
        last_checked_at:          toIso(r.last_checked_at),
        last_successful_check_at: toIso(r.last_successful_check_at),
        last_parse_status:        r.last_parse_status,
        votes: {
            confirmed: r.confirmed_count,
            complaint: r.complaint_count,
        },
        merchant: r.m_id != null ? {
            id:     r.m_id,
            name:   r.merchant_name,
            slug:   r.merchant_slug,
            domain: r.domain,
        } : null,
    };
}
