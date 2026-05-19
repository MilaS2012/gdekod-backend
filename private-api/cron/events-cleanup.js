// =============================================================================
// cron/events-cleanup.js — Yandex Cloud Functions Timer handler.
//
// Запускается раз в сутки. Удаляет события из events_log старше
// EVENTS_RETENTION_DAYS (180 дней) — требование 152-ФЗ о сроках
// хранения персональных данных.
//
// Контракт Cloud Functions Timer:
//   handler(event, context) → Promise<{ ok, deleted }>
//
// Весь handler обёрнут в try/catch — в том числе getPool().
// Для тестов принимает _deps.pool.
// =============================================================================

import { getPool } from '../lib/db.js';
import { cleanupOldEvents } from '../lib/events-cleanup.js';

/**
 * @param {object} [event]   — Cloud Functions Timer payload (не используется)
 * @param {object} [context] — Cloud Functions context
 * @param {{ pool?: object }} [_deps] — тестовые зависимости
 */
export async function handler(event, context, _deps = {}) {
    const start = Date.now();

    try {
        const pool    = _deps.pool ?? getPool();
        const deleted = await cleanupOldEvents({ pool });
        const ms      = Date.now() - start;
        console.log('[cron events-cleanup]', { deleted, ms });
        return { ok: true, deleted };
    } catch (err) {
        console.error('[cron events-cleanup] FAILED', {
            message: err?.message,
            ms: Date.now() - start,
        });
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
