// =============================================================================
// GET /api/admin/parser/urgent-queue?limit=N
//
// Защита: X-Parser-Secret.
//
// Coupons со «срочной» перепроверкой:
//   - status = 'active' (5+ жалоб уже автоматически переведены в expired в 6.7)
//   - complaint_count >= 3
//   - last_checked_at старше URGENT_RECHECK_INTERVAL_MINUTES
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../../lib/response.js';
import { requireParserSecret, ParserAuthError } from '../../../lib/parser-auth.js';
import {
    URGENT_RECHECK_INTERVAL_MINUTES,
} from '../../../lib/parser-config.js';
import { mapCoupon } from './coupons-list.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

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

        const q     = event?.queryStringParameters ?? {};
        const limit = parseIntInRange(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        if (limit == null) return badRequest('invalid_limit', { origin });

        const cutoff = new Date(Date.now() - URGENT_RECHECK_INTERVAL_MINUTES * 60 * 1000).toISOString();

        const rows = (await pool.query(
            `SELECT c.id, c.merchant_id, c.tier, c.status,
                    c.description, c.discount, c.code, c.expires_at,
                    c.last_checked_at, c.last_successful_check_at,
                    c.last_parse_status, c.last_complaint_at,
                    c.confirmed_count, c.complaint_count,
                    m.id AS m_id, m.name AS merchant_name, m.domain,
                    split_part(m.domain, '.', 1) AS merchant_slug
               FROM public_data.coupons c
               LEFT JOIN public_data.merchants m ON m.id = c.merchant_id
              WHERE c.status = 'active'
                AND c.complaint_count >= 3
                AND (c.last_checked_at IS NULL OR c.last_checked_at < $1::timestamptz)
              ORDER BY c.complaint_count DESC, c.last_complaint_at DESC NULLS LAST
              LIMIT $2`,
            [cutoff, limit],
        )).rows;

        const total = (await pool.query(
            `SELECT count(*)::int AS c
               FROM public_data.coupons
              WHERE status = 'active'
                AND complaint_count >= 3
                AND (last_checked_at IS NULL OR last_checked_at < $1::timestamptz)`,
            [cutoff],
        )).rows[0].c;

        const items = rows.map(r => ({
            ...mapCoupon(r),
            last_complaint_at: toIso(r.last_complaint_at),
        }));

        console.log('[parser.urgent_queue]', {
            request_id: requestId, count: items.length, total,
        });

        return ok({
            items, total, limit,
            recheck_interval_minutes: URGENT_RECHECK_INTERVAL_MINUTES,
        }, { origin });
    } catch (err) {
        console.error('[parser.urgent_queue]', { request_id: requestId, message: err?.message });
        return serverError({ origin, requestId });
    }
}

function parseIntInRange(raw, def, min, max) {
    if (raw == null) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}
