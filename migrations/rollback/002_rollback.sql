-- ============================================================================
-- rollback 002 — снимает email-поля и partial unique с private_data.users.
-- На проде безопасно при условии, что данные в этих колонках можно потерять.
-- ============================================================================

DROP INDEX IF EXISTS private_data.idx_users_email_unique;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS email_reminder_last_shown_at;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS email_reminder_dismissed_at;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS email_reminder_dismissed_count;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS email;
