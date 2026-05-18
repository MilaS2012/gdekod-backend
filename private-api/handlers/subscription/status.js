// =============================================================================
// GET /api/subscription/status
//
// Авторизованный. Возвращает:
//   - active: есть ли у user активная подписка
//   - subscription: данные текущей (active|pending|cancelled) или null
//   - available_tariffs: список тарифов с их провайдерами для UI
//     (на staging для daily_35 будет только operator_mock; на production
//     без подключённых операторов будет [] → UI должен скрыть тариф)
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { TARIFFS, getAvailableProviders } from '../../lib/billing-config.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')           return corsPreflight(origin);
    if (method && method !== 'GET')     return methodNotAllowed(['GET', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        // Самая свежая «живая» подписка пользователя (active / pending / cancelled).
        // Если cancelled, но доступ ещё не истёк — пользователь должен видеть
        // её статус и дату окончания.
        const row = (await pool.query(
            `SELECT id, tariff, provider, status, amount_kopecks, currency,
                    created_at, activated_at, cancelled_at, expires_at, next_charge_at
               FROM private_data.subscriptions
              WHERE user_id = $1
                AND status IN ('active', 'pending', 'cancelled')
              ORDER BY created_at DESC
              LIMIT 1`,
            [userId],
        )).rows[0];

        const subscription = row ? {
            id:              row.id,
            tariff:          row.tariff,
            provider:        row.provider,
            status:          row.status,
            amount_kopecks:  row.amount_kopecks,
            currency:        row.currency,
            created_at:      toIso(row.created_at),
            activated_at:    toIso(row.activated_at),
            cancelled_at:    toIso(row.cancelled_at),
            expires_at:      toIso(row.expires_at),
            next_charge_at:  toIso(row.next_charge_at),
        } : null;

        const available_tariffs = Object.entries(TARIFFS).map(([tariff, conf]) => ({
            tariff,
            amount_kopecks: conf.amount_kopecks,
            display_name:   conf.display_name,
            providers:      [...getAvailableProviders(tariff)],
        }));

        console.log('[subscription.status]', {
            request_id: requestId,
            user_id:    userId,
            active:     row?.status === 'active',
        });

        return ok({
            active:           row?.status === 'active',
            subscription,
            available_tariffs,
        }, { origin });
    } catch (err) {
        console.error('[subscription.status]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
