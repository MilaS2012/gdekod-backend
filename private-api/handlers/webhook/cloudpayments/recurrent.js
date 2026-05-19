// =============================================================================
// POST /api/webhook/cloudpayments/recurrent
//
// Webhook от CloudPayments об АВТОПРОДЛЕНИИ подписки (этап 7).
// Запускается CloudPayments'ом каждые 30 дней после успешной /pay.
//
// Отличия от /pay:
//   - UPDATE WHERE status='active' (НЕ 'pending') — cancelled НЕ продлевается
//   - expires_at     = expires_at     + interval '30 days' (extend, не from now)
//   - next_charge_at = next_charge_at + interval '30 days'
//   - last_charge_at = now()  (тот же)
//   - receipt.period_start = OLD expires_at, period_end = NEW expires_at
//   - notify kind = 'subscription_renewed' (не 'activated')
//   - event_type = 'subscription_renewed_cloudpayments'
//
// HMAC + idempotency — идентичны /pay.
// =============================================================================

import { getPool } from '../../../lib/db.js';
import {
    ok, badRequest, forbidden, methodNotAllowed, serverError, getOrigin,
} from '../../../lib/response.js';
import { verifyWebhookHmac } from '../../../lib/cloudpayments.js';
import { notifyTransactional } from '../../../lib/notifications.js';

export async function handler(event, context, _deps = {}) {
    const pool      = _deps.pool ?? getPool();
    const requestId = context?.requestId ?? null;
    const origin    = getOrigin(event);

    if (event?.httpMethod !== 'POST') {
        return methodNotAllowed(['POST'], { origin });
    }

    // ─── 1. RAW body для HMAC ───────────────────────────────────────────────
    const rawBody = event?.body ?? '';
    const headers = event?.headers ?? {};
    const receivedHmac =
        headers['content-hmac'] ?? headers['Content-HMAC'] ?? '';

    let isValidSig;
    try {
        isValidSig = verifyWebhookHmac(rawBody, receivedHmac);
    } catch (err) {
        console.error('[webhook.cp.recurrent] hmac_config_error', {
            request_id: requestId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
    if (!isValidSig) {
        return forbidden({ error: 'invalid_hmac' }, { origin });
    }

    // ─── 2. Parse JSON (после HMAC) ─────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return badRequest('invalid_json', { origin });
    }

    const transactionId = String(payload?.TransactionId ?? '');
    const invoiceId =
        typeof payload?.InvoiceId === 'string' ? payload.InvoiceId : null;
    const amount = Number(payload?.Amount);

    if (!transactionId || !invoiceId) {
        console.error('[webhook.cp.recurrent] missing_required_fields', {
            request_id: requestId,
            has_transaction_id: !!transactionId,
            has_invoice_id:     !!invoiceId,
        });
        return badRequest('missing_fields', { origin });
    }

    try {
        // ─── 3. Idempotency через provider_payment_id ───────────────────────
        const existing = (await pool.query(
            `SELECT id FROM private_data.receipts
              WHERE provider_payment_id = $1`,
            [transactionId],
        )).rows;
        if (existing.length > 0) {
            console.log('[webhook.cp.recurrent] idempotent_skip', {
                request_id: requestId, transaction_id: transactionId,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 4. SELECT subscription ─────────────────────────────────────────
        const sub = (await pool.query(
            `SELECT id, user_id, status, amount_kopecks, provider, expires_at
               FROM private_data.subscriptions
              WHERE id = $1
                AND provider IN ('cloudpayments_card', 'cloudpayments_sbp')`,
            [invoiceId],
        )).rows[0];
        if (!sub) {
            console.warn('[webhook.cp.recurrent] subscription_not_found', {
                request_id: requestId,
                invoice_id: invoiceId,
                transaction_id: transactionId,
            });
            return ok({ code: 0 }, { origin });
        }

        // Сохраняем OLD expires_at для period_start в receipt.
        const oldExpiresAt = sub.expires_at;

        // ─── 5. Race-safe UPDATE — ТОЛЬКО active подписки продлеваем ────────
        const upd = (await pool.query(
            `UPDATE private_data.subscriptions
                SET expires_at     = expires_at     + interval '30 days',
                    next_charge_at = next_charge_at + interval '30 days',
                    last_charge_at = now()
              WHERE id = $1 AND status = 'active'
              RETURNING id, user_id, expires_at`,
            [sub.id],
        )).rows[0];
        if (!upd) {
            // Sub cancelled/paused/expired — НЕ продлеваем. Это нормально:
            // юзер отменил подписку до даты следующего списания.
            console.log('[webhook.cp.recurrent] sub_not_active_skipped', {
                request_id: requestId,
                subscription_id: sub.id,
                actual_status:   sub.status,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 6. INSERT receipt — period = (old_expires_at, new_expires_at) ──
        await pool.query(
            `INSERT INTO private_data.receipts
               (user_id, subscription_id, amount_kopecks, currency,
                provider, provider_payment_id,
                is_mock, is_failed,
                period_start, period_end)
             VALUES ($1, $2, $3, 'RUB', $4, $5, false, false, $6, $7)`,
            [upd.user_id, upd.id, sub.amount_kopecks, sub.provider,
             transactionId, oldExpiresAt, upd.expires_at],
        );

        // ─── 7. events_log audit ────────────────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.events_log
               (user_id, event_type, payload)
             VALUES ($1, 'subscription_renewed_cloudpayments', $2)`,
            [upd.user_id, JSON.stringify({
                subscription_id: upd.id,
                transaction_id:  transactionId,
                amount_rubles:   amount,
            })],
        );

        // ─── 8. notifyTransactional — best-effort ───────────────────────────
        try {
            await notifyTransactional(
                { user_id: upd.user_id, kind: 'subscription_renewed',
                  request_id: requestId },
                { pool },
            );
        } catch (notifyErr) {
            console.warn('[webhook.cp.recurrent] notify_failed', {
                request_id: requestId,
                user_id:    upd.user_id,
                message:    notifyErr?.message,
            });
        }

        console.log('[webhook.cp.recurrent]', {
            request_id:      requestId,
            subscription_id: upd.id,
            user_id:         upd.user_id,
            transaction_id:  transactionId,
            amount_rubles:   amount,
        });
        return ok({ code: 0 }, { origin });

    } catch (err) {
        console.error('[webhook.cp.recurrent] error', {
            request_id:     requestId,
            transaction_id: transactionId,
            invoice_id:     invoiceId,
            message:        err?.message,
        });
        return serverError({ origin, requestId });
    }
}
