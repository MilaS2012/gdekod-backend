// =============================================================================
// cron/scheduled-deletions.js — Yandex Cloud Functions Timer handler.
//
// Запускается каждый час. Финально удаляет аккаунты, у которых:
//   - deletion_scheduled_at <= now()  (grace-период 24ч истёк)
//   - deletion_completed_at IS NULL   (ещё не помечены как выполненные)
//
// Идемпотентен: атомарный claim через UPDATE … RETURNING исключает
// повторную обработку при параллельном запуске.
//
// Контракт Cloud Functions Timer:
//   handler(event, context) → Promise<{ ok, processed, deleted, failed }>
//
// Весь handler обёрнут в try/catch — в том числе getPool().
// Для тестов принимает _deps.pool.
// =============================================================================

import { getPool } from '../lib/db.js';
import { processScheduledDeletions } from '../lib/account-cleanup.js';

/**
 * @param {object} [event]   — Cloud Functions Timer payload (не используется)
 * @param {object} [context] — Cloud Functions context
 * @param {{ pool?: object }} [_deps] — тестовые зависимости
 */
export async function handler(event, context, _deps = {}) {
    const start = Date.now();

    try {
        const pool   = _deps.pool ?? getPool();
        const result = await processScheduledDeletions({ pool });
        const ms     = Date.now() - start;
        console.log('[cron scheduled-deletions]', { ...result, ms });
        return { ok: true, ...result };
    } catch (err) {
        console.error('[cron scheduled-deletions] FAILED', {
            message: err?.message,
            ms: Date.now() - start,
        });
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
