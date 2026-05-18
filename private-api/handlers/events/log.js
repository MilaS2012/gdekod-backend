// =============================================================================
// POST /api/events
//
// Авторизованный. Аналитический журнал действий user'а (ТЗ v16.1 §21.2).
//
// Input:
//   {
//     event_type:   string (из EVENT_TYPES),
//     payload?:     object (произвольный JSON, ≤ PAYLOAD_MAX_BYTES после
//                   JSON.stringify),
//     coupon_id?:   positive int,
//     merchant_id?: positive int,
//   }
//
// Output: 200 { ok: true } — без event_id (клиенту не нужно, минимизируем
// размер ответа на горячем пути).
//
// Rate-limit — in-memory счётчик (lib/events-rate-limit.js), не БД.
// Аналитика — частая операция, COUNT(*) на горячем пути бессмыслен.
// Trade-off задокументирован в шапке events-rate-limit.js.
//
// ★ НЕ логируем содержимое payload — он может быть большим и содержать
//   чувствительные данные. Успешный INSERT тоже не логируем — это
//   нормальный поток, в логи попадёт только request_id Cloud Functions.
//   Логируем только аномалии (rate-limit, неизвестный event_type, ошибки).
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, methodNotAllowed, tooManyRequests, unauthorized,
    serverError, corsPreflight, parseJsonBody, getOrigin,
} from '../../lib/response.js';
import { EVENT_TYPES, EVENTS_LIMITS } from '../../lib/events-config.js';
import { checkEventRate } from '../../lib/events-rate-limit.js';
import { extractIp, extractUserAgent, userAgentHash } from '../../lib/event.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    let eventType = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });

        // event_type
        eventType = typeof body.event_type === 'string' ? body.event_type : null;
        if (!eventType || !EVENT_TYPES.includes(eventType)) {
            console.warn('[events.invalid_type]', {
                request_id: requestId, user_id: userId,
                event_type_provided: typeof eventType === 'string'
                    ? eventType.slice(0, 64)
                    : null,
            });
            return badRequest('invalid_event_type', { origin });
        }

        // payload (опциональный)
        let payload = null;
        if (body.payload != null) {
            if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
                return badRequest('invalid_payload', { origin });
            }
            // Сериализуем заранее — иначе размер невозможно проверить
            // до INSERT'а. Длина строки JSON в JS = UTF-16 code units;
            // для ASCII-payload'ов это равно байтам.
            let serialized;
            try { serialized = JSON.stringify(body.payload); }
            catch { return badRequest('invalid_payload', { origin }); }
            if (serialized.length > EVENTS_LIMITS.PAYLOAD_MAX_BYTES) {
                return badRequest('payload_too_large', { origin });
            }
            payload = serialized;
        }

        // coupon_id / merchant_id (опциональные)
        let couponId = null;
        if (isFieldPresent(body.coupon_id)) {
            couponId = parsePositiveInt(body.coupon_id);
            if (couponId === null) return badRequest('invalid_coupon_id', { origin });
        }
        let merchantId = null;
        if (isFieldPresent(body.merchant_id)) {
            merchantId = parsePositiveInt(body.merchant_id);
            if (merchantId === null) return badRequest('invalid_merchant_id', { origin });
        }

        // ─── Rate-limit ──────────────────────────────────────────────────────
        const rate = checkEventRate(userId);
        if (!rate.allowed) {
            console.warn('[events.rate_limited]', {
                request_id: requestId, user_id: userId,
                retry_after_seconds: rate.retryAfterSeconds,
            });
            return tooManyRequests({
                error: 'too_many_events',
            }, { origin, retryAfterSeconds: rate.retryAfterSeconds });
        }

        // ─── Тех. контекст ───────────────────────────────────────────────────
        const ip = extractIp(event);
        const ua = extractUserAgent(event);
        const uaHash = userAgentHash(ua);

        await pool.query(
            `INSERT INTO private_data.events_log
               (user_id, event_type, payload, coupon_id, merchant_id,
                ip_address, user_agent_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, eventType, payload, couponId, merchantId, ip, uaHash],
        );

        return ok({ ok: true }, { origin });
    } catch (err) {
        console.error('[events.log]', {
            request_id: requestId, user_id: userId, event_type: eventType,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}

// Различение «поле не передано» vs «поле передано, но битое» —
// отдельными функциями. Раньше было одной с три-значным возвратом
// (null / undefined / number), что через 3 месяца читается плохо.
function isFieldPresent(raw) {
    return raw !== undefined && raw !== null && raw !== '';
}
function parsePositiveInt(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}
