// =============================================================================
// GET /api/account/receipts
//
// Авторизованный. Возвращает чеки пользователя — фискальные документы
// от CloudPayments и оператора, плюс mock-чеки от staging-симулятора.
//
// receipt_url доступен только для prod-чеков (есть ссылка на чек ОФД).
// Для is_mock=true ссылки нет — это эмуляция, не реальное списание.
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
            `SELECT id, amount_kopecks, currency, provider,
                    provider_payment_id, provider_receipt_url,
                    is_mock, period_start, period_end, created_at,
                    subscription_id
               FROM private_data.receipts
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2 OFFSET $3`,
            [userId, limit, offset],
        )).rows;

        const total = (await pool.query(
            `SELECT count(*)::int AS c FROM private_data.receipts WHERE user_id = $1`,
            [userId],
        )).rows[0].c;

        const items = rows.map(r => ({
            id:                r.id,
            amount_rub:        r.amount_kopecks / 100,
            amount_kopecks:    r.amount_kopecks,
            currency:          r.currency,
            provider:          r.provider,
            is_mock:           r.is_mock,
            subscription_id:   r.subscription_id,
            period_start:      toIso(r.period_start),
            period_end:        toIso(r.period_end),
            paid_at:           toIso(r.created_at),
            receipt_url:       r.provider_receipt_url,
        }));

        return ok({ items, total, limit, offset }, { origin });
    } catch (err) {
        console.error('[account.receipts]', {
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
