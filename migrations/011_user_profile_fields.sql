-- ============================================================================
-- 011_user_profile_fields.sql — поля профиля для PATCH /api/account/profile
--
-- display_name VARCHAR(50) — публичное имя пользователя для UI ЛК.
-- profile_updated_at TIMESTAMPTZ — для аудита (триггер trg_users_updated_at
-- обновляет users.updated_at на любой UPDATE; profile_updated_at специфичен
-- для изменений профиля, отделён от внутренних UPDATE-ов).
-- ============================================================================

ALTER TABLE private_data.users
    ADD COLUMN IF NOT EXISTS display_name VARCHAR(50) NULL;

ALTER TABLE private_data.users
    ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ NULL;
