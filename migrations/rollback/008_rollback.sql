-- ============================================================================
-- rollback 008 — снимает таблицу subscriptions и её индексы.
-- ★ Каскадно сносит receipts.subscription_id через ON DELETE SET NULL
--   (миграция 009 создаёт ссылку nullable именно для этого).
-- ============================================================================

DROP INDEX IF EXISTS private_data.idx_subs_one_active_per_user;
DROP INDEX IF EXISTS private_data.idx_subs_next_charge;
DROP INDEX IF EXISTS private_data.idx_subs_user_status;
DROP TABLE IF EXISTS private_data.subscriptions CASCADE;
