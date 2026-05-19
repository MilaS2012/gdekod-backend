// =============================================================================
// POST /api/webhook/cloudpayments/pay
//
// Webhook от CloudPayments о УСПЕШНОЙ первой оплате подписки (этап 7).
// Не клиентский endpoint — сервер-к-серверу из инфраструктуры CloudPayments.
//
// Аутентификация: HMAC-SHA256 подпись raw body, заголовок Content-HMAC.
// Без валидной подписи → 403 (CloudPayments не ретраит 4xx).
//
// Логика:
//   1. Verify HMAC по RAW body (НЕ JSON.parse до проверки!)
//   2. Parse JSON
//   3. Idempotency: SELECT receipts WHERE provider_payment_id = TransactionId
//      → если есть, return {code:0} (повторный webhook от CloudPayments)
//   4. SELECT subscription WHERE id=InvoiceId AND provider IN (cp_card, cp_sbp)
//      → если нет, return {code:0} + log WARN (битый InvoiceId, не возвращаем 4xx
//        чтобы CloudPayments не ретраил бесконечно)
//   5. Race-safe UPDATE WHERE status='pending' RETURNING …
//      → если 0 rows, return {code:0} (другой webhook опередил или статус не pending)
//   6. INSERT receipt с is_mock=false, is_failed=false, provider_payment_id
//      (UNIQUE constraint idx_receipts_payment_id — belt поверх idempotency-SELECT)
//   7. INSERT events_log 'subscription_activated_cloudpayments' (audit)
//   8. notifyTransactional kind='subscription_activated' (best-effort try/catch)
//   9. return ok({ code: 0 })
//
// CloudPayments-протокол: ответ HTTP 200 + body {code:0} = успех.
// Любое другое body code или HTTP 5xx → CloudPayments повторит webhook.
// HTTP 4xx → НЕ повторит (атака / некорректный запрос).
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

    // ─── 1. RAW body для HMAC — НЕ JSON.parse до verify! ────────────────────
    const rawBody = event?.body ?? '';
    const headers = event?.headers ?? {};
    const receivedHmac =
        headers['content-hmac'] ?? headers['Content-HMAC'] ?? '';

    let isValidSig;
    try {
        isValidSig = verifyWebhookHmac(rawBody, receivedHmac);
    } catch (err) {
        // CLOUDPAYMENTS_WEBHOOK_SECRET не задан в env — конфиг-ошибка.
        console.error('[webhook.cp.pay] hmac_config_error', {
            request_id: requestId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
    if (!isValidSig) {
        return forbidden({ error: 'invalid_hmac' }, { origin });
    }

    // ─── 2. Parse JSON (только после HMAC!) ─────────────────────────────────
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
        console.error('[webhook.cp.pay] missing_required_fields', {
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
            console.log('[webhook.cp.pay] idempotent_skip', {
                request_id: requestId, transaction_id: transactionId,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 4. SELECT subscription ─────────────────────────────────────────
        const sub = (await pool.query(
            `SELECT id, user_id, status, tariff, amount_kopecks, provider
               FROM private_data.subscriptions
              WHERE id = $1
                AND provider IN ('cloudpayments_card', 'cloudpayments_sbp')`,
            [invoiceId],
        )).rows[0];
        if (!sub) {
            console.warn('[webhook.cp.pay] subscription_not_found', {
                request_id: requestId,
                invoice_id: invoiceId,
                transaction_id: transactionId,
            });
            // Не отдаём 4xx — CloudPayments может ретраить, и в дальнейшем
            // subscription может появиться (race с пользовательским запросом).
            return ok({ code: 0 }, { origin });
        }

        // ─── 5. Race-safe UPDATE pending → active ───────────────────────────
        const upd = (await pool.query(
            `UPDATE private_data.subscriptions
                SET status         = 'active',
                    activated_at   = now(),
                    expires_at     = now() + interval '30 days',
                    next_charge_at = now() + interval '30 days',
                    last_charge_at = now()
              WHERE id = $1 AND status = 'pending'
              RETURNING id, user_id, expires_at`,
            [sub.id],
        )).rows[0];
        if (!upd) {
            // Другой webhook уже активировал, или sub cancelled. Это
            // нормальная ситуация — просто пропускаем.
            console.log('[webhook.cp.pay] status_already_changed', {
                request_id: requestId,
                subscription_id: sub.id,
                actual_status:   sub.status,
            });
            return ok({ code: 0 }, { origin });
        }

        // ─── 6. INSERT receipt ──────────────────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.receipts
               (user_id, subscription_id, amount_kopecks, currency,
                provider, provider_payment_id,
                is_mock, is_failed,
                period_start, period_end)
             VALUES ($1, $2, $3, 'RUB', $4, $5, false, false,
                     now(), $6)`,
            [upd.user_id, upd.id, sub.amount_kopecks, sub.provider,
             transactionId, upd.expires_at],
        );

        // ─── 7. events_log audit ────────────────────────────────────────────
        await pool.query(
            `INSERT INTO private_data.events_log
               (user_id, event_type, payload)
             VALUES ($1, 'subscription_activated_cloudpayments', $2)`,
            [upd.user_id, JSON.stringify({
                subscription_id: upd.id,
                transaction_id:  transactionId,
                amount_rubles:   amount,
            })],
        );

        // ─── 8. notifyTransactional — best-effort ───────────────────────────
        try {
            await notifyTransactional(
                { user_id: upd.user_id, kind: 'subscription_activated',
                  request_id: requestId },
                { pool },
            );
        } catch (notifyErr) {
            console.warn('[webhook.cp.pay] notify_failed', {
                request_id: requestId,
                user_id:    upd.user_id,
                message:    notifyErr?.message,
            });
        }

        console.log('[webhook.cp.pay]', {
            request_id:      requestId,
            subscription_id: upd.id,
            user_id:         upd.user_id,
            transaction_id:  transactionId,
            amount_rubles:   amount,
        });
        return ok({ code: 0 }, { origin });

    } catch (err) {
        console.error('[webhook.cp.pay] error', {
            request_id:     requestId,
            transaction_id: transactionId,
            invoice_id:     invoiceId,
            message:        err?.message,
        });
        // 5xx → CloudPayments повторит webhook. Допустимо для transient ошибок БД.
        return serverError({ origin, requestId });
    }
}
