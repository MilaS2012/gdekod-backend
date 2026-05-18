// =============================================================================
// mock-cron.js — эмуляция ежедневных списаний для подписок с
// provider='operator_mock' на staging (ТЗ v16.1 §3.3.2).
//
// На production:
//   - operator_mock запрещён CHECK constraint'ом subs_provider_check
//     (на самом деле он в наборе, но недоступен через UI/handler из-за
//      assertNoMockInProduction в billing-config)
//   - assertNoMockInProduction() здесь — повторная защита от случайного
//     запуска этой функции в production кроне.
//
// Каждый прогон:
//   1. SELECT ... FOR UPDATE SKIP LOCKED — параллельные таймеры не дерутся
//   2. INSERT receipts с is_mock=true (1 день оплачено)
//   3. UPDATE subscriptions: продлеваем expires_at и next_charge_at на сутки
//
// pg-mem может не поддерживать FOR UPDATE SKIP LOCKED — для тестов
// предусмотрен альтернативный режим без блокировки (deps.skipForUpdate).
// =============================================================================

import { getPool } from './db.js';
import { assertNoMockInProduction } from './billing-config.js';

/**
 * Один прогон mock-cron: обрабатывает все подписки с operator_mock,
 * у которых next_charge_at <= now(). Возвращает количество обработанных.
 *
 * @param {{ pool?: object, skipForUpdate?: boolean, batchLimit?: number }} [deps]
 * @returns {Promise<number>} количество обработанных подписок
 */
export async function processMockDailyCharges(deps = {}) {
    assertNoMockInProduction();

    const pool          = deps.pool ?? getPool();
    const batchLimit    = deps.batchLimit ?? 100;
    // FOR UPDATE SKIP LOCKED — production-safe конкурентность.
    // В тестах на pg-mem это может не парситься — передаём skipForUpdate=true.
    const lockClause    = deps.skipForUpdate ? '' : 'FOR UPDATE SKIP LOCKED';

    const { rows } = await pool.query(
        `SELECT id, user_id, amount_kopecks, expires_at, tariff
           FROM private_data.subscriptions
          WHERE provider = 'operator_mock'
            AND status   = 'active'
            AND next_charge_at <= now()
          LIMIT $1
          ${lockClause}`,
        [batchLimit],
    );

    for (const sub of rows) {
        // 1. Создаём mock-чек за прошедший день.
        await pool.query(
            `INSERT INTO private_data.receipts
               (user_id, subscription_id, amount_kopecks, currency,
                provider, is_mock, period_start, period_end)
             VALUES ($1, $2, $3, 'RUB', 'operator_mock', true,
                     now(), now() + interval '1 day')`,
            [sub.user_id, sub.id, sub.amount_kopecks],
        );

        // 2. Продлеваем подписку на сутки.
        await pool.query(
            `UPDATE private_data.subscriptions
                SET expires_at     = expires_at     + interval '1 day',
                    next_charge_at = next_charge_at + interval '1 day'
              WHERE id = $1`,
            [sub.id],
        );

        console.log('[mock.daily_charge]', {
            subscription_id: sub.id,
            user_id:         sub.user_id,
            amount_kopecks:  sub.amount_kopecks,
            tariff:          sub.tariff,
        });
    }

    return rows.length;
}
