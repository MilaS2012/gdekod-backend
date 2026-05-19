// =============================================================================
// webhook-cp-fail.test.js — POST /api/webhook/cloudpayments/fail (этап 7).
//
// Группа D из спеки. Покрытие 5 тестов:
//   D1 — без HMAC → 403
//   D2 — active sub → status='paused_payment_failed'
//   D3 — уже paused → idempotent {code:0}, второй receipt НЕ создан
//   D4 — receipt с is_failed=true, period=(now,now) — нулевой период
//   D5 — notifyTransactional kind='payment_failed' вызван (через console.log)
//
// Ключевые отличия от /pay и /recurrent:
//   - UPDATE WHERE status='active' → 'paused_payment_failed'
//   - Receipt is_failed=true, period_start = period_end = now()
//   - notifyTransactional в try/catch с log.ERROR (не warn) при провале
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as failHandler } from '../handlers/webhook/cloudpayments/fail.js';
import {
    newPgMemPool,
    createTestUser,
    setTestCpSecrets,
    resetTestCpSecrets,
    signCpWebhook,
} from './helpers.js';

// -----------------------------------------------------------------------------
// Хелперы
// -----------------------------------------------------------------------------

async function setupActiveSub(pool) {
    const { user_id } = await createTestUser(pool);
    const sub = (await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, expires_at, next_charge_at)
         VALUES ($1, 'monthly_499', 'cloudpayments_card', 'active', 49900,
                 now() - interval '29 days', now() + interval '1 day',
                 now() + interval '1 day')
         RETURNING id`,
        [user_id],
    )).rows[0];
    return { user_id, subscription_id: sub.id };
}

async function markPaused(pool, subscription_id) {
    await pool.query(
        `UPDATE private_data.subscriptions
            SET status = 'paused_payment_failed'
          WHERE id = $1`,
        [subscription_id],
    );
}

function failPayload({ subscription_id, user_id,
                       transaction_id = 'cp_fail_' + Math.random().toString(36).slice(2, 10),
                       reason_code = 5051,
                       cp_status = 'Declined' } = {}) {
    return {
        TransactionId: transaction_id,
        InvoiceId:     subscription_id,
        AccountId:     user_id,
        Amount:        499,
        Currency:      'RUB',
        Status:        cp_status,
        ReasonCode:    reason_code,
    };
}

function signedEvent(payload, opts = {}) {
    const rawBody = JSON.stringify(payload);
    return {
        httpMethod: 'POST',
        headers: { 'content-hmac': opts.hmac ?? signCpWebhook(rawBody) },
        body: rawBody,
    };
}

function captureConsole() {
    const logs = [];
    const origLog   = console.log;
    const origWarn  = console.warn;
    const origError = console.error;
    console.log   = (...args) => logs.push({ level: 'log',   args });
    console.warn  = (...args) => logs.push({ level: 'warn',  args });
    console.error = (...args) => logs.push({ level: 'error', args });
    return {
        logs,
        restore() {
            console.log = origLog; console.warn = origWarn; console.error = origError;
        },
    };
}

function parseBody(r) { return JSON.parse(r.body); }

// =============================================================================
// D — webhook /fail
// =============================================================================

test('D1: без HMAC заголовка → 403 invalid_hmac', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupActiveSub(pool);

    const rawBody = JSON.stringify(failPayload({ subscription_id, user_id }));
    const event = { httpMethod: 'POST', headers: {}, body: rawBody };

    const r = await failHandler(event, {}, { pool });
    assert.equal(r.statusCode, 403);
    assert.equal(parseBody(r).error, 'invalid_hmac');
    resetTestCpSecrets();
});

test('D2: active sub → status="paused_payment_failed"', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupActiveSub(pool);

    const r = await failHandler(
        signedEvent(failPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    const status = (await pool.query(
        `SELECT status FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].status;
    assert.equal(status, 'paused_payment_failed');
    resetTestCpSecrets();
});

test('D3: уже paused → idempotent {code:0}, второй receipt НЕ создан', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupActiveSub(pool);
    await markPaused(pool, subscription_id);

    // Webhook прилетает на УЖЕ paused sub — UPDATE WHERE status='active'
    // вернёт 0 rows → пропускаем INSERT receipt.
    const r = await failHandler(
        signedEvent(failPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    // Receipt не должен создаваться (UPDATE 0 rows → skip)
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0].c;
    assert.equal(c, 0, 'не должен создаваться receipt для уже paused sub');

    // Status остался paused
    const status = (await pool.query(
        `SELECT status FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].status;
    assert.equal(status, 'paused_payment_failed');
    resetTestCpSecrets();
});

test('D4: receipt — is_failed=true, period=(now,now), provider_payment_id=TX', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupActiveSub(pool);
    const TX = 'cp_fail_d4_test_tx';
    const before = Date.now();

    await failHandler(
        signedEvent(failPayload({ subscription_id, user_id, transaction_id: TX })),
        {}, { pool },
    );

    const r = (await pool.query(
        `SELECT is_mock, is_failed, provider_payment_id,
                period_start, period_end, amount_kopecks
           FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0];
    assert.equal(r.is_mock,              false);
    assert.equal(r.is_failed,            true,  '★ ключевой маркер для /fail');
    assert.equal(r.provider_payment_id,  TX);
    assert.equal(r.amount_kopecks,       49900);

    // period_start ≈ period_end ≈ now() (нулевой период)
    const startMs = new Date(r.period_start).getTime();
    const endMs   = new Date(r.period_end).getTime();
    assert.ok(Math.abs(endMs - startMs) < 2000,
              `period_end должен быть ~period_start (нулевой период), diff=${endMs - startMs}ms`);
    assert.ok(startMs >= before - 1000 && startMs <= Date.now() + 1000,
              'period_start должен быть ~now()');
    resetTestCpSecrets();
});

test('D5: notifyTransactional kind="payment_failed" вызван', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id } = await setupActiveSub(pool);
    const cap = captureConsole();

    await failHandler(
        signedEvent(failPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    cap.restore();

    const notifyLog = cap.logs.find(l =>
        l.level === 'log' &&
        String(l.args[0]).includes('notification.queued') &&
        l.args[1]?.kind === 'payment_failed'
    );
    assert.ok(notifyLog,
              'notifyTransactional должен залогировать [notification.queued] kind=payment_failed');

    // Дополнительно: сам факт provala залогирован WARN-ом (не error)
    const warnLog = cap.logs.find(l =>
        l.level === 'warn' && String(l.args[0]).includes('webhook.cp.fail')
    );
    assert.ok(warnLog, 'сам факт provala должен быть на WARN-уровне');
    resetTestCpSecrets();
});
