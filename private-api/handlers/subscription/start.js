// =============================================================================
// POST /api/subscription/start
//
// Авторизованный. Создаёт новую подписку.
//
// Input:  { tariff, provider }
// Output: зависит от ветки — см. ниже.
//
// Логика по provider:
//
//   operator_mock (staging only):
//     - Сразу status='active' + receipt is_mock=true, без реальных списаний.
//     - Mock-cron каждые сутки имитирует продление (lib/mock-cron.js).
//
//   cloudpayments_card / cloudpayments_sbp:
//     - status='pending', возвращаем widget_config для CloudPayments Widget API.
//     - Фронт инициализирует виджет с publicId/amount/accountId/invoiceId.
//     - Webhook от CloudPayments (POST /api/webhook/cloudpayments/pay)
//       переведёт status='active' и создаст receipt.
//
//   operator_megafon / operator_t2 / operator_beeline:
//     - status='pending', ждём SMS-consent оператора (этап 10).
//     - Webhook от оператора переведёт status='active'.
//
// Защиты:
//   - Только один active subscription на user (uniq index на БД +
//     409 на уровне приложения, чтобы дать чистый message).
//   - tariff × provider matching проверяется ДО INSERT (lib/billing-config),
//     иначе CHECK в БД даёт 500 без понятной ошибки.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, badRequest, conflict, methodNotAllowed, unauthorized, serverError,
    corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../../lib/response.js';
import {
    TARIFFS, isProviderAllowedForTariff, assertNoMockInProduction,
} from '../../lib/billing-config.js';
import { notifyTransactional } from '../../lib/notifications.js';
import { kopecksToRubles } from '../../lib/cloudpayments.js';

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

        // ─── 1. Парсинг + валидация input ────────────────────────────────────
        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });
        const tariff   = typeof body.tariff   === 'string' ? body.tariff   : null;
        const provider = typeof body.provider === 'string' ? body.provider : null;
        if (!tariff || !TARIFFS[tariff]) {
            return badRequest('invalid_tariff', { origin });
        }
        if (!provider || !isProviderAllowedForTariff(tariff, provider)) {
            return badRequest('provider_not_available', { origin });
        }

        // ─── 2. Уже есть активная подписка? ──────────────────────────────────
        const existing = (await pool.query(
            `SELECT id FROM private_data.subscriptions
              WHERE user_id = $1 AND status = 'active'`,
            [userId],
        )).rows[0];
        if (existing) {
            return conflict({
                error: 'already_subscribed',
                existing_subscription_id: existing.id,
                message: 'Сначала отмените текущую подписку',
            }, { origin });
        }

        // ─── 3. Логика по provider ───────────────────────────────────────────
        const tariffConf    = TARIFFS[tariff];
        const amountKopecks = tariffConf.amount_kopecks;
        const periodSec     = tariffConf.period_seconds;

        if (provider === 'operator_mock') {
            // STAGING-only ветка — сразу активируем.
            assertNoMockInProduction();
            const now      = new Date();
            const expires  = new Date(now.getTime() + periodSec * 1000);
            // next_charge — момент следующего «списания» (для daily +1 день).
            const nextChg  = new Date(now.getTime() + periodSec * 1000);

            const sub = (await pool.query(
                `INSERT INTO private_data.subscriptions
                   (user_id, tariff, provider, status, amount_kopecks,
                    activated_at, expires_at, next_charge_at)
                 VALUES ($1, $2, 'operator_mock', 'active', $3, $4, $5, $6)
                 RETURNING id, activated_at, expires_at, next_charge_at`,
                [userId, tariff, amountKopecks, now, expires, nextChg],
            )).rows[0];

            // Mock-чек за первый день.
            await pool.query(
                `INSERT INTO private_data.receipts
                   (user_id, subscription_id, amount_kopecks, currency,
                    provider, is_mock, period_start, period_end)
                 VALUES ($1, $2, $3, 'RUB', 'operator_mock', true, $4, $5)`,
                [userId, sub.id, amountKopecks, now, expires],
            );

            console.log('[subscription.activated.mock]', {
                request_id: requestId, user_id: userId,
                subscription_id: sub.id, tariff, provider,
            });

            // §3.6.2 Шаблон 2: «ГдеКод: подписка 35₽/сутки активна»
            await notifyTransactional(
                { user_id: userId, kind: 'subscription_activated',
                  params: { tariff, amount_kopecks: amountKopecks },
                  request_id: requestId },
                { pool },
            );

            return ok({
                subscription_id: sub.id,
                status:          'active',
                activated_at:    toIso(sub.activated_at),
                expires_at:      toIso(sub.expires_at),
            }, { origin });
        }

        if (provider === 'cloudpayments_card' || provider === 'cloudpayments_sbp') {
            // CloudPayments Widget API: фронту нужны параметры инициализации.
            // publicId — ОБЯЗАТЕЛЕН из env. Без него виджет не откроется,
            // поэтому fail-loud в production вместо silent 'undefined' в ответе.
            const publicId = process.env.CLOUDPAYMENTS_PUBLIC_ID;
            if (!publicId) {
                console.error('[subscription.start] CLOUDPAYMENTS_PUBLIC_ID не задан в env', {
                    request_id: requestId, user_id: userId, tariff, provider,
                });
                return serverError({ origin, requestId });
            }

            const sub = (await pool.query(
                `INSERT INTO private_data.subscriptions
                   (user_id, tariff, provider, status, amount_kopecks)
                 VALUES ($1, $2, $3, 'pending', $4)
                 RETURNING id`,
                [userId, tariff, provider, amountKopecks],
            )).rows[0];

            console.log('[subscription.pending_cloudpayments]', {
                request_id: requestId, user_id: userId,
                subscription_id: sub.id, tariff, provider,
            });

            return ok({
                subscription_id: sub.id,
                status:          'pending',
                next_step:       'open_cloudpayments_widget',
                widget_config: {
                    publicId,
                    amount:      kopecksToRubles(amountKopecks),
                    currency:    'RUB',
                    description: `Подписка ГдеКод — ${TARIFFS[tariff].display_name}`,
                    accountId:   userId,
                    invoiceId:   sub.id,
                    skin:        'modern',
                },
            }, { origin });
        }

        // operator_megafon / operator_t2 / operator_beeline (только production).
        if (provider.startsWith('operator_') && provider !== 'operator_mock') {
            // Дублируем защиту — этот путь не должен срабатывать на staging.
            assertNoMockInProduction();
            const sub = (await pool.query(
                `INSERT INTO private_data.subscriptions
                   (user_id, tariff, provider, status, amount_kopecks)
                 VALUES ($1, $2, $3, 'pending', $4)
                 RETURNING id`,
                [userId, tariff, provider, amountKopecks],
            )).rows[0];

            console.log('[subscription.pending_operator]', {
                request_id: requestId, user_id: userId,
                subscription_id: sub.id, tariff, provider,
            });

            return ok({
                subscription_id: sub.id,
                status:          'pending',
                next_step:       'wait_for_operator_sms',
                message:         'Ожидайте SMS от оператора связи с подтверждением подписки',
            }, { origin });
        }

        // Сюда не должны прийти — isProviderAllowedForTariff отсеял бы выше.
        return badRequest('provider_not_available', { origin });
    } catch (err) {
        console.error('[subscription.start]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
