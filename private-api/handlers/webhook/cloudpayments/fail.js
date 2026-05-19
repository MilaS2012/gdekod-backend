// =============================================================================
// POST /api/webhook/cloudpayments/fail
//
// Webhook от CloudPayments о НЕУДАЧНОМ платеже (этап 7).
// Status в payload — 'Declined' или 'Cancelled'.
//
// Логика:
//   1. Verify HMAC по RAW body
//   2. Parse JSON
//   3. Idempotency через provider_payment_id (тот же паттерн)
//   4. SELECT subscription
//   5. UPDATE WHERE status='active' → 'paused_payment_failed'
//      Если 0 rows (sub cancelled/уже paused/pending) → {code:0} без receipt
//   6. INSERT receipt с is_failed=true, period = (now, now) — нулевой период
//      (платёж не прошёл, услуга не предоставлена)
//   7. events_log 'subscription_payment_failed_cloudpayments'
//   8. notifyTransactional kind='payment_failed' — try/catch с log.error
//      (НЕ log.warn как в pay/recurrent — оповещение о провале платежа
//      критично, юзер должен узнать и обновить карту до окончания grace)
//
// Лог самого факта provala — на WARN-уровне (это негативное событие, но
// не ошибка сервера).
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
        console.error('[webhook.cp.fail] hmac_config_error', {
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
    const reasonCode = payload?.ReasonCode ?? null;
    const cpStatus   = payload?.Status ?? null;

    if (!transactionId || !invoiceId) {
        console.error('[webhook.cp.fail] missing_required_fields', {
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
            console.log('[webhook.cp.fail] idempotent_skip', {
                request_id: requestId, transaction_id: transactionId,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 4. SELECT subscription ─────────────────────────────────────────
        const sub = (await pool.query(
            `SELECT id, user_id, status, amount_kopecks, provider
               FROM private_data.subscriptions
              WHERE id = $1
                AND provider IN ('cloudpayments_card', 'cloudpayments_sbp')`,
            [invoiceId],
        )).rows[0];
        if (!sub) {
            console.warn('[webhook.cp.fail] subscription_not_found', {
                request_id: requestId,
                invoice_id: invoiceId,
                transaction_id: transactionId,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 5. UPDATE active → paused_payment_failed ───────────────────────
        const upd = (await pool.query(
            `UPDATE private_data.subscriptions
                SET status = 'paused_payment_failed'
              WHERE id = $1 AND status = 'active'
              RETURNING id, user_id`,
            [sub.id],
        )).rows[0];
        if (!upd) {
            // Sub не active (уже paused / cancelled / pending). Это
            // нормальная ситуация — например, повторный fail webhook
            // или fail для уже отменённой подписки.
            console.log('[webhook.cp.fail] sub_not_active_skipped', {
                request_id: requestId,
                subscription_id: sub.id,
                actual_status:   sub.status,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 6. INSERT receipt с is_failed=true, period=(now,now) ───────────
        // period нулевой — услуга не предоставлена (платёж не прошёл).
        await pool.query(
            `INSERT INTO private_data.receipts
               (user_id, subscription_id, amount_kopecks, currency,
                provider, provider_payment_id,
                is_mock, is_failed,
                period_start, period_end)
             VALUES ($1, $2, $3, 'RUB', $4, $5, false, true, now(), now())`,
            [upd.user_id, upd.id, sub.amount_kopecks, sub.provider,
             transactionId],
        );

        // ─── 7. events_log audit ────────────────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.events_log
               (user_id, event_type, payload)
             VALUES ($1, 'subscription_payment_failed_cloudpayments', $2)`,
            [upd.user_id, JSON.stringify({
                subscription_id: upd.id,
                transaction_id:  transactionId,
                reason_code:     reasonCode,
                cp_status:       cpStatus,
            })],
        );

        // ─── 8. notifyTransactional — try/catch с log.ERROR (не warn) ───────
        // КРИТИЧНО: пользователь должен узнать о проблеме с оплатой
        // и обновить карту до конца grace-периода. Если notify упал —
        // log.error для алерта, но webhook всё равно завершаем успешно
        // (БД уже обновлена, повтор от CloudPayments создаст дубль receipt
        //  через UNIQUE constraint — поэтому даём {code:0}).
        try {
            await notifyTransactional(
                { user_id: upd.user_id, kind: 'payment_failed',
                  request_id: requestId },
                { pool },
            );
        } catch (notifyErr) {
            console.error('[webhook.cp.fail] notify_failed', {
                request_id: requestId,
                user_id:    upd.user_id,
                message:    notifyErr?.message,
            });
        }

        // Лог самого факта provala — WARN (это негативное событие).
        console.warn('[webhook.cp.fail]', {
            request_id:      requestId,
            subscription_id: upd.id,
            user_id:         upd.user_id,
            transaction_id:  transactionId,
            reason_code:     reasonCode,
            cp_status:       cpStatus,
        });
        return ok({ code: 0 }, { origin });

    } catch (err) {
        console.error('[webhook.cp.fail] error', {
            request_id:     requestId,
            transaction_id: transactionId,
            invoice_id:     invoiceId,
            message:        err?.message,
        });
        return serverError({ origin, requestId });
    }
}
