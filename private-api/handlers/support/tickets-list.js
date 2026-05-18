// =============================================================================
// GET /api/support/tickets
//
// Авторизованный. Список тикетов user'а с пагинацией. Возвращаем только
// заголовочные поля — message/contact_phone/contact_email НЕ в списке
// (для UI достаточно subject + status; полный текст — отдельным
// endpoint'ом, если когда-нибудь понадобится).
//
// Query:
//   status — 'open' | 'in_progress' | 'closed' | 'all' (default 'all')
//   limit  — 1..50 (default 20)
//   offset — >=0 (default 0)
//
// Спам-категория ('spam') в выдачу не попадает — отфильтровываем
// явно (юзер не должен видеть, что его тикет помечен как спам).
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;
const ALLOWED_STATUSES = ['open', 'in_progress', 'closed', 'all'];

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
        const status = (q.status ?? 'all').toString();
        if (!ALLOWED_STATUSES.includes(status)) {
            return badRequest('invalid_status', { origin });
        }
        const limit  = parseIntInRange(q.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = parseIntInRange(q.offset, 0,             0, 1_000_000);
        if (limit == null || offset == null) {
            return badRequest('invalid_pagination', { origin });
        }

        // 'spam' — внутренний админский статус. Юзеру не показываем
        // даже при status=all:
        //   (1) защита UX — обидное «вы помечены как спам»
        //   (2) не даём атакующему информацию о фильтре
        //   (3) пометка — это сигнал админу, не часть UX
        // ALLOWED_STATUSES для query тоже не содержит 'spam' — нельзя
        // запросить ?status=spam (это вернёт 400 invalid_status).
        const rows = (await pool.query(
            `SELECT id, category, subject, status, created_at, updated_at, closed_at
               FROM private_data.support_tickets
              WHERE user_id = $1
                AND status <> 'spam'
                AND ($2::text = 'all' OR status = $2)
              ORDER BY created_at DESC
              LIMIT $3 OFFSET $4`,
            [userId, status, limit, offset],
        )).rows;

        const total = (await pool.query(
            `SELECT count(*)::int AS c
               FROM private_data.support_tickets
              WHERE user_id = $1
                AND status <> 'spam'
                AND ($2::text = 'all' OR status = $2)`,
            [userId, status],
        )).rows[0].c;

        const items = rows.map(r => ({
            id:         r.id,
            category:   r.category,
            subject:    r.subject,
            status:     r.status,
            created_at: toIso(r.created_at),
            updated_at: toIso(r.updated_at),
            closed_at:  toIso(r.closed_at),
        }));

        return ok({ items, total, limit, offset }, { origin });
    } catch (err) {
        console.error('[support.tickets_list]', {
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
