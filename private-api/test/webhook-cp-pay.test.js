// =============================================================================
// webhook-cp-pay.test.js — POST /api/webhook/cloudpayments/pay (этап 7).
//
// Группа B из спеки. Покрытие 10 тестов:
//   B1   — без HMAC заголовка → 403
//   B2   — неверный HMAC → 403
//   B3   — валидный HMAC + pending sub → 200 {code:0}, sub активирована
//   B4   — повторный вызов после успешного pay → {code:0} без дубликата receipt
//   B5   — TransactionId уже в receipts (idempotency-SELECT) → {code:0}
//   B6   — subscription не найдена → {code:0} + log WARN
//   B7   — после pay: subscription.status='active'
//   B8   — после pay: activated_at, expires_at, last_charge_at заполнены
//   B9   — после pay: receipt с is_mock=false, is_failed=false, provider_payment_id
//   B10  — notifyTransactional вызван (capture через console.log)
//
// Webhook'и идут от server-to-server (CloudPayments), не от браузера — поэтому
// CORS / Origin / JWT не проверяем. Только HMAC.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as payHandler } from '../handlers/webhook/cloudpayments/pay.js';
import {
    newPgMemPool,
    createTestUser,
    setTestCpSecrets,
    resetTestCpSecrets,
    signCpWebhook,
} from './helpers.js';

// -----------------------------------------------------------------------------
// Хелперы для построения webhook-payload'а
// -----------------------------------------------------------------------------

/** Создаёт user + pending cloudpayments subscription. */
async function setupPendingSub(pool, { provider = 'cloudpayments_card' } = {}) {
    const { user_id } = await createTestUser(pool);
    const sub = (await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks)
         VALUES ($1, 'monthly_499', $2, 'pending', 49900)
         RETURNING id, user_id`,
        [user_id, provider],
    )).rows[0];
    return { user_id, subscription_id: sub.id };
}

/** Стандартный payload CloudPayments /pay. */
function payPayload({ subscription_id, user_id,
                       transaction_id = 'cp_tx_' + Math.random().toString(36).slice(2, 10),
                       amount = 499 } = {}) {
    return {
        TransactionId: transaction_id,
        InvoiceId:     subscription_id,
        AccountId:     user_id,
        Amount:        amount,
        Currency:      'RUB',
        Status:        'Completed',
        CardFirstSix:  '411111',
        CardLastFour:  '1111',
    };
}

/** event с правильно подписанным body. */
function signedEvent(payload, opts = {}) {
    const rawBody = JSON.stringify(payload);
    return {
        httpMethod: 'POST',
        headers: {
            'content-hmac': opts.hmac ?? signCpWebhook(rawBody),
            ...(opts.extraHeaders ?? {}),
        },
        body: rawBody,
    };
}

/** Перехват console.log/warn — для проверки notifyTransactional. */
function captureConsole() {
    const logs = [];
    const origLog  = console.log;
    const origWarn = console.warn;
    console.log  = (...args) => logs.push({ level: 'log',  args });
    console.warn = (...args) => logs.push({ level: 'warn', args });
    return {
        logs,
        restore() { console.log = origLog; console.warn = origWarn; },
    };
}

function parseBody(r) { return JSON.parse(r.body); }

// =============================================================================
// B — webhook /pay
// =============================================================================

test('B1: без HMAC заголовка → 403 invalid_hmac', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    const rawBody = JSON.stringify(payPayload({ subscription_id, user_id }));
    const event = {
        httpMethod: 'POST',
        headers: {},               // нет Content-HMAC
        body: rawBody,
    };
    const r = await payHandler(event, {}, { pool });
    assert.equal(r.statusCode, 403);
    assert.equal(parseBody(r).error, 'invalid_hmac');
    resetTestCpSecrets();
});

test('B2: неверный HMAC → 403 invalid_hmac', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    const event = signedEvent(payPayload({ subscription_id, user_id }), {
        hmac: 'definitely_not_a_valid_signature_xxxx==',
    });
    const r = await payHandler(event, {}, { pool });
    assert.equal(r.statusCode, 403);
    resetTestCpSecrets();
});

test('B3: валидный HMAC + pending sub → 200 {code:0}', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    const r = await payHandler(
        signedEvent(payPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });
    resetTestCpSecrets();
});

test('B4: повторный вызов после успешного pay → {code:0} без второго receipt', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    const payload = payPayload({ subscription_id, user_id });

    // Первый вызов: успех
    const r1 = await payHandler(signedEvent(payload), {}, { pool });
    assert.equal(r1.statusCode, 200);

    // Второй вызов — тот же TransactionId. Idempotent.
    const r2 = await payHandler(signedEvent(payload), {}, { pool });
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(parseBody(r2), { code: 0 });

    // В receipts должна быть РОВНО одна запись
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0].c;
    assert.equal(c, 1, 'не должно быть дубликата receipt при повторном webhook');
    resetTestCpSecrets();
});

test('B5: TransactionId уже в receipts → idempotent skip без UPDATE', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    // Вручную вставляем receipt с этим TransactionId (имитация другого инстанса)
    const TX = 'cp_tx_preexisting_98765';
    await pool.query(
        `INSERT INTO private_data.receipts
           (user_id, subscription_id, amount_kopecks, currency,
            provider, provider_payment_id,
            is_mock, is_failed, period_start, period_end)
         VALUES ($1, $2, 49900, 'RUB', 'cloudpayments_card', $3,
                 false, false, now(), now() + interval '30 days')`,
        [user_id, subscription_id, TX],
    );

    const r = await payHandler(
        signedEvent(payPayload({ subscription_id, user_id, transaction_id: TX })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    // Subscription ОСТАЛАСЬ pending (idempotency сработала ДО UPDATE).
    const status = (await pool.query(
        `SELECT status FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].status;
    assert.equal(status, 'pending',
                 'idempotent skip должен сработать ДО UPDATE — sub остаётся pending');
    resetTestCpSecrets();
});

test('B6: subscription не найдена → {code:0} + log WARN', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const cap = captureConsole();

    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const r = await payHandler(
        signedEvent(payPayload({ subscription_id: fakeUuid, user_id: fakeUuid })),
        {}, { pool },
    );
    cap.restore();

    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    const warnLog = cap.logs.find(l =>
        l.level === 'warn' &&
        String(l.args[0]).includes('subscription_not_found')
    );
    assert.ok(warnLog, 'должен быть console.warn с subscription_not_found');
    resetTestCpSecrets();
});

test('B7: после pay → subscription.status="active"', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);

    await payHandler(
        signedEvent(payPayload({ subscription_id, user_id })),
        {}, { pool },
    );

    const status = (await pool.query(
        `SELECT status FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].status;
    assert.equal(status, 'active');
    resetTestCpSecrets();
});

test('B8: после pay → activated_at, expires_at, last_charge_at заполнены', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);
    const before = Date.now();

    await payHandler(
        signedEvent(payPayload({ subscription_id, user_id })),
        {}, { pool },
    );

    const sub = (await pool.query(
        `SELECT activated_at, expires_at, last_charge_at, next_charge_at
           FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0];
    assert.ok(sub.activated_at != null,    'activated_at должен быть заполнен');
    assert.ok(sub.last_charge_at != null,  'last_charge_at должен быть заполнен');
    assert.ok(sub.expires_at != null,      'expires_at должен быть заполнен');

    // expires_at ~ now + 30 дней
    const expires = new Date(sub.expires_at).getTime();
    const expected = before + 30 * 86_400 * 1000;
    assert.ok(Math.abs(expires - expected) < 10_000,
              `expires_at должен быть ~now+30d, diff=${expires - expected}ms`);
    resetTestCpSecrets();
});

test('B9: receipt — is_mock=false, is_failed=false, provider_payment_id=TransactionId', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);
    const TX = 'cp_tx_b9_unique_value';

    await payHandler(
        signedEvent(payPayload({ subscription_id, user_id, transaction_id: TX })),
        {}, { pool },
    );

    const r = (await pool.query(
        `SELECT is_mock, is_failed, provider, provider_payment_id, amount_kopecks
           FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0];
    assert.equal(r.is_mock,             false);
    assert.equal(r.is_failed,           false);
    assert.equal(r.provider,            'cloudpayments_card');
    assert.equal(r.provider_payment_id, TX);
    assert.equal(r.amount_kopecks,      49900);
    resetTestCpSecrets();
});

test('B10: notifyTransactional вызван (captured через [notification.queued])', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupPendingSub(pool);
    const cap = captureConsole();

    await payHandler(
        signedEvent(payPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    cap.restore();

    const notifyLog = cap.logs.find(l =>
        l.level === 'log' &&
        String(l.args[0]).includes('notification.queued') &&
        l.args[1]?.kind === 'subscription_activated'
    );
    assert.ok(notifyLog,
              'notifyTransactional должен залогировать [notification.queued] kind=subscription_activated');
    resetTestCpSecrets();
});
