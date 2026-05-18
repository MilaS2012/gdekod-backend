// =============================================================================
// mock-cron.test.js — processMockDailyCharges (6.6).
//
// pg-mem не парсит FOR UPDATE SKIP LOCKED → передаём deps.skipForUpdate=true.
// Production использует дефолтный путь с блокировкой.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { processMockDailyCharges } from '../lib/mock-cron.js';
import {
    newPgMemPool,
    createTestUser,
} from './helpers.js';

const savedNodeEnv = process.env.NODE_ENV;
const savedMock    = process.env.MOCK_OPERATOR_BILLING;
function restoreEnv() {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else                             process.env.NODE_ENV = savedNodeEnv;
    if (savedMock === undefined)    delete process.env.MOCK_OPERATOR_BILLING;
    else                             process.env.MOCK_OPERATOR_BILLING = savedMock;
}

/** Прямой INSERT mock-подписки с настраиваемым next_charge_at (offset в секундах назад). */
async function insertMockSubscription(pool, user_id, { nextChargeOffsetSeconds = 0 } = {}) {
    const now = new Date();
    const nextChargeAt = new Date(now.getTime() - nextChargeOffsetSeconds * 1000);
    const expiresAt    = new Date(now.getTime() + 86_400 * 1000);
    const { rows } = await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, expires_at, next_charge_at)
         VALUES ($1, 'daily_35', 'operator_mock', 'active', 3500,
                 now(), $2, $3)
         RETURNING id, expires_at, next_charge_at`,
        [user_id, expiresAt, nextChargeAt],
    );
    return rows[0];
}

// =============================================================================
// Группа H — mock-cron
// =============================================================================

test('31: 0 подписок → returns 0', async () => {
    const pool = await newPgMemPool();
    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 0);
});

test('32: 1 mock active с next_charge_at в прошлом → обработан, receipt создан, expires_at +1 день', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const sub = await insertMockSubscription(pool, user_id, { nextChargeOffsetSeconds: 60 });

    const before = new Date(sub.expires_at).getTime();

    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 1);

    // Receipt создан с is_mock=true
    const r = (await pool.query(
        `SELECT amount_kopecks, is_mock, provider FROM private_data.receipts WHERE subscription_id = $1`,
        [sub.id])).rows[0];
    assert.equal(r.amount_kopecks, 3500);
    assert.equal(r.is_mock, true);
    assert.equal(r.provider, 'operator_mock');

    // expires_at сдвинут на сутки вперёд
    const updated = (await pool.query(
        `SELECT expires_at FROM private_data.subscriptions WHERE id = $1`, [sub.id])).rows[0];
    const after = new Date(updated.expires_at).getTime();
    const diffHours = Math.round((after - before) / (3600 * 1000));
    assert.equal(diffHours, 24, `expires_at должен сдвинуться на ~24 часа, получено ${diffHours}ч`);
});

test('33: 5 подписок mock active в прошлом → все обрабатываются', async () => {
    const pool = await newPgMemPool();
    for (let i = 0; i < 5; i++) {
        const { user_id } = await createTestUser(pool, `+7926${String(i).padStart(7, '0')}`);
        await insertMockSubscription(pool, user_id, { nextChargeOffsetSeconds: 60 });
    }

    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 5);

    const receipts = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts WHERE is_mock = true`)).rows[0].c;
    assert.equal(receipts, 5);
});

test('34: cloudpayments-подписки игнорируются mock-cron', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, expires_at, next_charge_at)
         VALUES ($1, 'monthly_499', 'cloudpayments_card', 'active', 49900,
                 now(), now() + interval '30 days', now() - interval '1 minute')`,
        [user_id],
    );

    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 0, 'cloudpayments не должна обрабатываться mock-cron');

    const receipts = (await pool.query(
        `SELECT count(*)::int AS c FROM private_data.receipts`)).rows[0].c;
    assert.equal(receipts, 0);
});

test('35: production + MOCK=true → throws assertNoMockInProduction', async () => {
    const pool = await newPgMemPool();
    process.env.NODE_ENV = 'production';
    process.env.MOCK_OPERATOR_BILLING = 'true';

    await assert.rejects(
        () => processMockDailyCharges({ pool, skipForUpdate: true }),
        /CRITICAL.*MOCK_OPERATOR_BILLING.*production/,
    );
    restoreEnv();
});

test('mock-cron: подписки с next_charge_at в БУДУЩЕМ — не трогаются', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    // next_charge через час — пока не пора
    await insertMockSubscription(pool, user_id, { nextChargeOffsetSeconds: -3600 });

    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 0);
});

test('mock-cron: cancelled подписки не обрабатываются', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, cancelled_at, expires_at, next_charge_at)
         VALUES ($1, 'daily_35', 'operator_mock', 'cancelled', 3500,
                 now(), now(), now() + interval '1 day', now() - interval '1 hour')`,
        [user_id],
    );

    const count = await processMockDailyCharges({ pool, skipForUpdate: true });
    assert.equal(count, 0);
});
