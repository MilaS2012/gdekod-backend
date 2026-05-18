-- ============================================================================
-- rollback 009 — снимает таблицу receipts.
-- Должен запускаться ДО rollback 008 (subscriptions), потому что receipts
-- ссылается на subscriptions. ROLLBACK_PATTERN сортирует по убыванию
-- номера → 009 запускается раньше 008. ОК.
-- ============================================================================

DROP INDEX IF EXISTS private_data.idx_receipts_subscription;
DROP INDEX IF EXISTS private_data.idx_receipts_user_created;
DROP TABLE IF EXISTS private_data.receipts CASCADE;
