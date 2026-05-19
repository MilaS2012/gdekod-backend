// =============================================================================
// account-cleanup.js — финальное удаление user'ов с истёкшим grace period
// (152-ФЗ §14, ТЗ v16.1 §19.3, §21).
//
// Вызывается cron-таймером Yandex Cloud Functions (поднимается в 6.10).
// Каждый user, у которого:
//   deletion_scheduled_at < now()  AND  deletion_completed_at IS NULL
// — окончательно удаляется через DELETE FROM users (CASCADE заберёт
// auth_sessions, otp_codes (нет, у них нет FK на user — связь по phone),
// email_verify_tokens, magic_link_tokens, coupon_reveals, coupon_votes,
// subscriptions, receipts, support_tickets, account_deletion_otp_codes;
// events_log → ON DELETE SET NULL: события остаются обезличенными).
//
// ★ Idempotency через атомарный claim — три шага на каждого user'а:
//
//   1. UPDATE users SET deletion_completed_at = now()
//      WHERE id = $1 AND deletion_completed_at IS NULL
//      RETURNING id
//
//      → Если 0 rows — другой инстанс cron'а уже забрал этого user'а
//        (или мы повторно подхватили его из устаревшего SELECT'а). Skip.
//
//   2. INSERT INTO events_log (user_id, event_type='deletion_completed')
//
//      → Audit trail. После DELETE user_id обнулится через ON DELETE SET NULL
//        (для 152-ФЗ это правильно: следов идентификации не остаётся,
//        но факт «удаление произошло» в журнале сохранён).
//
//   3. DELETE FROM users WHERE id = $1
//
// ★ Если упадём после шага 1 но до шага 3:
//   user остаётся в БД с deletion_completed_at != NULL. На следующем
//   тике partial-индекс idx_users_deletion_scheduled его НЕ подхватит
//   (фильтр deletion_completed_at IS NULL). Audit trail в events_log
//   уже есть. Требуется монитор/алерт «users WITH
//   deletion_completed_at IS NOT NULL» — это маркер failed deletion attempt
//   для ручного разбора админом.
//
// ★ Resilient к ошибкам отдельных user'ов: try/catch вокруг каждой
//   итерации. Один сбойный user не останавливает всю партию.
//
// ★ TODO 6.10 / прод: 54-ФЗ требует хранения чеков 3 года. CASCADE
//   удалит receipts вместе с user'ом. У нас копии чеков есть у
//   CloudPayments + ФНС получает чеки напрямую от него, но если ФНС
//   попросит наши копии — нужен archive-механизм перед DELETE
//   (отдельная таблица `_archived_receipts` без user_id).
// =============================================================================

import { getPool } from './db.js';
import { CLEANUP_BATCH_SIZE } from './account-deletion-config.js';

/**
 * Обрабатывает партию scheduled deletions.
 *
 * @param {{ pool?: object, requestId?: string|null }} [deps]
 * @returns {Promise<{ processed: number, deleted: number, failed: number }>}
 */
export async function processScheduledDeletions(deps = {}) {
    const pool      = deps.pool ?? getPool();
    const requestId = deps.requestId ?? null;
    const nowIso    = new Date().toISOString();

    // ─── SELECT партии ───────────────────────────────────────────────────────
    // Используем ISO-string для сравнения через absolute timestamp
    // (pg-mem не дружит с `now() - interval` в WHERE — см. шапку
    // migrations.test.js пункт 11).
    const { rows: candidates } = await pool.query(
        `SELECT id
           FROM private_data.users
          WHERE deletion_scheduled_at IS NOT NULL
            AND deletion_scheduled_at < $1
            AND deletion_completed_at IS NULL
          ORDER BY deletion_scheduled_at ASC
          LIMIT $2`,
        [nowIso, CLEANUP_BATCH_SIZE],
    );

    let deleted = 0;
    let failed  = 0;

    for (const u of candidates) {
        try {
            // ─── 1. Атомарный claim ──────────────────────────────────────────
            const claim = (await pool.query(
                `UPDATE private_data.users
                    SET deletion_completed_at = now()
                  WHERE id = $1 AND deletion_completed_at IS NULL
                  RETURNING id`,
                [u.id],
            )).rows;
            if (claim.length === 0) {
                // Другой инстанс cron'а уже взял этого user'а — пропускаем
                // без подсчёта в failed (это нормальный сценарий race
                // против concurrent cron'ов).
                continue;
            }

            // ─── 2. Audit trail в events_log ────────────────────────────────
            // user_id ещё валидный (DELETE будет шагом ниже). После DELETE
            // через ON DELETE SET NULL user_id обнулится — журнал остаётся
            // как «факт удаления был» без идентификации.
            await pool.query(
                `INSERT INTO private_data.events_log (user_id, event_type)
                 VALUES ($1, 'deletion_completed')`,
                [u.id],
            );

            // ─── 3. DELETE FROM users — CASCADE заберёт всё связанное ───────
            await pool.query(
                `DELETE FROM private_data.users WHERE id = $1`,
                [u.id],
            );

            deleted++;
            console.log('[account.deletion_completed]', {
                request_id: requestId, user_id: u.id,
            });
        } catch (err) {
            failed++;
            // user'а после ошибки оставляем с deletion_completed_at != NULL
            // (если шаг 1 прошёл) или NULL (если упали ДО шага 1) — в обоих
            // случаях монитор увидит аномалию: либо «застрял с completed_at»,
            // либо «новый тик попытается снова».
            console.error('[account.deletion_failed]', {
                request_id: requestId, user_id: u.id, message: err?.message,
            });
        }
    }

    console.log('[account.cleanup_summary]', {
        request_id: requestId,
        processed:  candidates.length,
        deleted,
        failed,
    });

    return { processed: candidates.length, deleted, failed };
}
