// =============================================================================
// cron/mock-daily-charges.js — Yandex Cloud Functions Timer handler.
//
// Запускается раз в сутки (staging only) — эмулирует ежедневные списания
// по подпискам с provider='operator_mock'. На production подписки с
// operator_mock запрещены assertNoMockInProduction() в billing-config.js,
// поэтому processed всегда будет 0 даже если cron-триггер случайно сработает.
//
// Контракт Cloud Functions Timer:
//   handler(event, context) → Promise<{ ok, processed }>
//
// Весь handler обёрнут в try/catch — в том числе getPool(), который
// может не задать DATABASE_URL в env → не бросаем exception в Cloud Functions.
//
// Для тестов принимает _deps.pool и _deps.skipForUpdate (pg-mem не
// поддерживает FOR UPDATE SKIP LOCKED).
// =============================================================================

import { getPool } from '../lib/db.js';
import { processMockDailyCharges } from '../lib/mock-cron.js';

/**
 * @param {object} [event]   — Cloud Functions Timer payload (не используется)
 * @param {object} [context] — Cloud Functions context (requestId и т.п.)
 * @param {{ pool?: object, skipForUpdate?: boolean }} [_deps] — тестовые зависимости
 */
export async function handler(event, context, _deps = {}) {
    const start = Date.now();

    try {
        const pool          = _deps.pool ?? getPool();
        const skipForUpdate = _deps.skipForUpdate ?? false;

        const processed = await processMockDailyCharges({ pool, skipForUpdate });
        const ms = Date.now() - start;
        console.log('[cron mock-daily-charges]', { processed, ms });
        return { ok: true, processed };
    } catch (err) {
        console.error('[cron mock-daily-charges] FAILED', {
            message: err?.message,
            ms: Date.now() - start,
        });
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
