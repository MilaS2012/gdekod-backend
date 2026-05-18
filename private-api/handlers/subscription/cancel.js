// =============================================================================
// POST /api/subscription/cancel
//
// Авторизованный. Отменяет активную подписку user'а:
//   - status='cancelled', cancelled_at=now()
//   - next_charge_at=NULL — останавливаем будущие списания
//   - expires_at остаётся прежним: доступ к сервису сохраняется до этой даты
//     (правило «оплачено → отработать», ТЗ §3.5)
//
// Race-safe: один атомарный UPDATE … WHERE status='active' RETURNING …
//
// Уведомление: §3.6.2 Шаблон 4 «подписка отменена, доступ до DD.MM».
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, notFound, methodNotAllowed, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { notifyTransactional } from '../../lib/notifications.js';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const row = (await pool.query(
            `UPDATE private_data.subscriptions
                SET status         = 'cancelled',
                    cancelled_at   = now(),
                    next_charge_at = NULL
              WHERE user_id = $1 AND status = 'active'
              RETURNING id, tariff, provider, expires_at`,
            [userId],
        )).rows[0];

        if (!row) {
            return notFound('no_active_subscription', { origin });
        }

        console.log('[subscription.cancelled]', {
            request_id:        requestId,
            user_id:           userId,
            subscription_id:   row.id,
            tariff:            row.tariff,
            provider:          row.provider,
            access_until_iso:  toIso(row.expires_at),
        });

        // §3.6.2 Шаблон 4: «ГдеКод: подписка отменена. Доступ до DD.MM».
        await notifyTransactional(
            { user_id: userId, kind: 'subscription_cancelled',
              params: { access_until: toIso(row.expires_at) },
              request_id: requestId },
            { pool },
        );

        return ok({
            subscription_id: row.id,
            status:          'cancelled',
            access_until:    toIso(row.expires_at),
            message:         'Доступ к сервису сохраняется до окончания оплаченного периода',
        }, { origin });
    } catch (err) {
        console.error('[subscription.cancel]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
