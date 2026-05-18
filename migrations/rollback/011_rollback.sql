-- ============================================================================
-- rollback 011 — снимает поля профиля.
-- ============================================================================

ALTER TABLE private_data.users DROP COLUMN IF EXISTS profile_updated_at;
ALTER TABLE private_data.users DROP COLUMN IF EXISTS display_name;
