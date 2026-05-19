-- ============================================================================
-- rollback 014 — снимает soft-delete и таблицу account_deletion_otp_codes.
--
-- deletion_requested_at НЕ дропаем — это поле создано в 001.
-- ============================================================================

DROP INDEX IF EXISTS private_data.idx_deletion_otp_user_created;
DROP TABLE IF EXISTS private_data.account_deletion_otp_codes CASCADE;

DROP INDEX IF EXISTS private_data.idx_users_deletion_scheduled;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS deletion_completed_at;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS deletion_scheduled_at;
