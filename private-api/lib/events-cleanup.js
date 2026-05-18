// =============================================================================
// events-cleanup.js — retention cleanup для private_data.events_log.
//
// По ТЗ v16.1 §21.2: события хранятся 6 месяцев (EVENTS_RETENTION_DAYS=180),
// дальше — удаляем.
//
// В этапе 6.11 функция готова + покрыта тестами. Вызов из cron-таймера
// Yandex Cloud Functions подключается в этапе 6.10 (рядом с mock-cron
// биллинга и магой-чисткой просроченных токенов).
//
// API: cleanupOldEvents({ pool }) → number (количество удалённых строк).
//
// Cutoff считаем в JS (Date.now() - days * ms), не в SQL (`now() - interval`):
//   - детерминированный cutoff проще покрыть тестами (можно подменить Date.now);
//   - в логе видна точная граница, которую применили;
//   - совместимо с pg-mem (избегаем особенностей TIMESTAMPTZ-арифметики).
// =============================================================================

import { getPool } from './db.js';
import { EVENTS_RETENTION_DAYS } from './events-config.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Удаляет события старше EVENTS_RETENTION_DAYS дней.
 *
 * @param {{ pool?: object }} [deps] — инъекция pool для тестов
 * @returns {Promise<number>} количество удалённых строк
 */
export async function cleanupOldEvents(deps = {}) {
    const pool = deps.pool ?? getPool();

    const cutoff = new Date(Date.now() - EVENTS_RETENTION_DAYS * MS_PER_DAY);

    const { rowCount } = await pool.query(
        `DELETE FROM private_data.events_log
          WHERE created_at < $1`,
        [cutoff.toISOString()],
    );

    const deleted = rowCount ?? 0;
    console.log('[events.retention_cleanup]', {
        deleted_count:  deleted,
        cutoff_iso:     cutoff.toISOString(),
        retention_days: EVENTS_RETENTION_DAYS,
    });

    return deleted;
}
