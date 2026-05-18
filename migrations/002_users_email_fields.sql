-- ============================================================================
-- 002_users_email_fields.sql — email + поля баннера привязки (ТЗ §3.7.11)
--
-- email — резервный канал авторизации (magic link на новых устройствах).
-- email_reminder_* — состояние UI-баннера «Привяжи email» (§3.7.3):
--   - last_shown_at: не показываем чаще 1 раза в сутки
--   - dismissed_count: после 3 dismiss подряд баннер уезжает в Настройки
--   - dismissed_at: момент последнего dismiss (для "не сегодня")
-- ============================================================================

ALTER TABLE private_data.users ADD COLUMN IF NOT EXISTS email                          VARCHAR(255) NULL;
ALTER TABLE private_data.users ADD COLUMN IF NOT EXISTS email_verified_at              TIMESTAMPTZ  NULL;
ALTER TABLE private_data.users ADD COLUMN IF NOT EXISTS email_reminder_dismissed_count INT          NOT NULL DEFAULT 0;
ALTER TABLE private_data.users ADD COLUMN IF NOT EXISTS email_reminder_dismissed_at    TIMESTAMPTZ  NULL;
ALTER TABLE private_data.users ADD COLUMN IF NOT EXISTS email_reminder_last_shown_at   TIMESTAMPTZ  NULL;

-- Partial unique: email уникален среди НЕ-NULL значений.
-- Два пользователя без email — ОК. Два с одинаковым email — нельзя.
-- По §3.7.7 (Email уже привязан к другому аккаунту → 409).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON private_data.users (email)
    WHERE email IS NOT NULL;
