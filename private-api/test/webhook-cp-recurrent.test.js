// =============================================================================
// webhook-cp-recurrent.test.js — POST /api/webhook/cloudpayments/recurrent
// (этап 7).
//
// Группа C из спеки. Покрытие 5 тестов:
//   C1 — active sub → expires_at +30 дней
//   C2 — cancelled sub → тихо {code:0}, НЕ продлевается
//   C3 — last_charge_at обновлён, новый receipt создан
//   C4 — receipt.period_start = OLD expires_at, period_end = NEW expires_at
//   C5 — idempotency через TransactionId
//
// Ключевые отличия от /pay:
//   - UPDATE WHERE status='active' (не 'pending')
//   - expires_at += 30 days (extend, не from now)
//   - notify kind = 'subscription_renewed'
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as recurrentHandler } from '../handlers/webhook/cloudpayments/recurrent.js';
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

/** Создаёт user + ACTIVE cloudpayments subscription с явной expires_at. */
async function setupActiveSub(pool, { daysUntilExpiry = 1 } = {}) {
    const { user_id } = await createTestUser(pool);
    const expiresAt   = new Date(Date.now() + daysUntilExpiry * 86_400 * 1000);
    const nextCharge  = new Date(expiresAt.getTime() - 86_400 * 1000); // expires - 1 day
    const sub = (await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, expires_at, next_charge_at, last_charge_at)
         VALUES ($1, 'monthly_499', 'cloudpayments_card', 'active', 49900,
                 now() - interval '29 days', $2::timestamptz,
                 $3::timestamptz, now() - interval '29 days')
         RETURNING id, expires_at, last_charge_at`,
        [user_id, expiresAt.toISOString(), nextCharge.toISOString()],
    )).rows[0];
    return { user_id, subscription_id: sub.id,
             old_expires_at: sub.expires_at, old_last_charge_at: sub.last_charge_at };
}

/** Помечает subscription как cancelled. */
async function cancelSub(pool, subscription_id) {
    await pool.query(
        `UPDATE private_data.subscriptions
            SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1`,
        [subscription_id],
    );
}

function recurrentPayload({ subscription_id, user_id,
                            transaction_id = 'cp_rec_' + Math.random().toString(36).slice(2, 10),
                            amount = 499 } = {}) {
    return {
        TransactionId: transaction_id,
        InvoiceId:     subscription_id,
        AccountId:     user_id,
        Amount:        amount,
        Currency:      'RUB',
        Status:        'Completed',
    };
}

function signedEvent(payload) {
    const rawBody = JSON.stringify(payload);
    return {
        httpMethod: 'POST',
        headers: { 'content-hmac': signCpWebhook(rawBody) },
        body: rawBody,
    };
}

function parseBody(r) { return JSON.parse(r.body); }

// =============================================================================
// C — webhook /recurrent
// =============================================================================

test('C1: active sub → expires_at + 30 дней (продление от OLD expires_at)', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id, old_expires_at } =
        await setupActiveSub(pool, { daysUntilExpiry: 1 });

    const r = await recurrentHandler(
        signedEvent(recurrentPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    const sub = (await pool.query(
        `SELECT expires_at FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0];

    const newMs = new Date(sub.expires_at).getTime();
    const oldMs = new Date(old_expires_at).getTime();
    const diff  = newMs - oldMs;
    // 30 дней ±5с tolerance
    assert.ok(Math.abs(diff - 30 * 86_400 * 1000) < 5000,
              `expires_at должен сдвинуться на +30 дней, diff=${diff}ms`);
    resetTestCpSecrets();
});

test('C2: cancelled sub → тихо {code:0}, expires_at НЕ изменился, receipt не создан', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id, old_expires_at } =
        await setupActiveSub(pool, { daysUntilExpiry: 1 });
    await cancelSub(pool, subscription_id);

    const r = await recurrentHandler(
        signedEvent(recurrentPayload({ subscription_id, user_id })),
        {}, { pool },
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseBody(r), { code: 0 });

    // expires_at не сдвинулся
    const sub = (await pool.query(
        `SELECT expires_at, status FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0];
    assert.equal(sub.status, 'cancelled');
    assert.equal(
        new Date(sub.expires_at).getTime(),
        new Date(old_expires_at).getTime(),
        'expires_at не должен меняться для cancelled подписки',
    );

    // receipt не создан
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0].c;
    assert.equal(c, 0, 'receipt не должен создаваться для cancelled sub');
    resetTestCpSecrets();
});

test('C3: last_charge_at обновлён + новый receipt создан', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id, old_last_charge_at } =
        await setupActiveSub(pool);
    const before = Date.now();

    await recurrentHandler(
        signedEvent(recurrentPayload({ subscription_id, user_id })),
        {}, { pool },
    );

    const sub = (await pool.query(
        `SELECT last_charge_at FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0];
    assert.ok(
        new Date(sub.last_charge_at).getTime() > new Date(old_last_charge_at).getTime(),
        'last_charge_at должен обновиться на более позднее время',
    );
    assert.ok(
        new Date(sub.last_charge_at).getTime() >= before - 1000,
        'last_charge_at должен быть ~now()',
    );

    // Ровно один новый receipt
    const r = (await pool.query(
        `SELECT is_mock, is_failed, amount_kopecks, provider
           FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows;
    assert.equal(r.length, 1);
    assert.equal(r[0].is_mock,        false);
    assert.equal(r[0].is_failed,      false);
    assert.equal(r[0].amount_kopecks, 49900);
    resetTestCpSecrets();
});

test('C4: receipt.period_start = OLD expires_at, period_end = NEW expires_at', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id, old_expires_at } =
        await setupActiveSub(pool, { daysUntilExpiry: 2 });

    await recurrentHandler(
        signedEvent(recurrentPayload({ subscription_id, user_id })),
        {}, { pool },
    );

    const r = (await pool.query(
        `SELECT period_start, period_end FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0];
    const sub = (await pool.query(
        `SELECT expires_at FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0];

    // period_start = OLD expires_at (точно)
    assert.equal(
        new Date(r.period_start).getTime(),
        new Date(old_expires_at).getTime(),
        'period_start receipt должен равняться OLD expires_at',
    );
    // period_end = NEW expires_at
    assert.equal(
        new Date(r.period_end).getTime(),
        new Date(sub.expires_at).getTime(),
        'period_end receipt должен равняться NEW expires_at',
    );
    resetTestCpSecrets();
});

test('C5: idempotency через TransactionId — повторный recurrent не продляет ещё раз', async () => {
    setTestCpSecrets();
    const pool = await newPgMemPool();
    const { subscription_id, user_id, old_expires_at } =
        await setupActiveSub(pool, { daysUntilExpiry: 1 });

    const payload = recurrentPayload({ subscription_id, user_id });

    // Первый вызов: успех
    await recurrentHandler(signedEvent(payload), {}, { pool });
    const expiresAfter1 = (await pool.query(
        `SELECT expires_at FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].expires_at;

    // Повторный с ТЕМ ЖЕ TransactionId — idempotent
    const r2 = await recurrentHandler(signedEvent(payload), {}, { pool });
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(parseBody(r2), { code: 0 });

    // expires_at НЕ изменился между двумя вызовами
    const expiresAfter2 = (await pool.query(
        `SELECT expires_at FROM private_data.subscriptions WHERE id = $1`,
        [subscription_id],
    )).rows[0].expires_at;
    assert.equal(
        new Date(expiresAfter2).getTime(),
        new Date(expiresAfter1).getTime(),
        'expires_at не должен сдвигаться повторно при том же TransactionId',
    );

    // Ровно один receipt в БД
    const c = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts WHERE user_id = $1`,
        [user_id],
    )).rows[0].c;
    assert.equal(c, 1, 'не должно быть второго receipt при дубле webhook');
    resetTestCpSecrets();
});
