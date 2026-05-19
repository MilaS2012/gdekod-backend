-- ============================================================================
-- 014_account_deletion.sql — soft-delete с TTL 24ч и OTP-подтверждение
-- (152-ФЗ §14, ТЗ v16.1 §19.3, §21).
--
-- ДВА БЛОКА:
--
-- 1. Поля для soft-delete на users:
--    - deletion_scheduled_at — когда наступит окончательное удаление (now+24h)
--    - deletion_completed_at — атомарный claim в processScheduledDeletions:
--      перед DELETE FROM users cron делает UPDATE…WHERE deletion_completed_at IS NULL
--      RETURNING, чтобы другой инстанс cron'а не подхватил этого user (race).
--      Если cron упадёт между claim и DELETE — на следующем тике user НЕ
--      подхватится (deletion_completed_at != NULL фильтрует его), audit
--      trail в events_log уже есть. Требует monitoring/alert для админа.
--    (deletion_requested_at уже создан в 001 — повторно не объявляем.)
--
-- 2. Отдельная таблица account_deletion_otp_codes — НЕ ПЕРЕИСПОЛЬЗУЕМ
--    общий otp_codes, чтобы не трогать его partial unique и не задевать
--    300+ существующих login-тестов.
--    БЕЗ partial unique — атомарность одного активного OTP обеспечиваем
--    в коде (UPDATE…SET used_at=now() WHERE user_id=$1 AND used_at IS NULL
--    перед INSERT нового).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Soft-delete fields
-- ----------------------------------------------------------------------------

ALTER TABLE private_data.users
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ NULL;

ALTER TABLE private_data.users
    ADD COLUMN IF NOT EXISTS deletion_completed_at TIMESTAMPTZ NULL;

-- Partial index для cron'а: «users, ожидающие финального удаления».
-- После DELETE строка исчезает из таблицы и из индекса автоматически.
CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled
    ON private_data.users (deletion_scheduled_at)
    WHERE deletion_scheduled_at IS NOT NULL
      AND deletion_completed_at IS NULL;


-- ----------------------------------------------------------------------------
-- 2. Account deletion OTP codes (отдельная таблица)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS private_data.account_deletion_otp_codes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL
                                REFERENCES private_data.users(id) ON DELETE CASCADE,

    -- HMAC-SHA256(OTP_HMAC_SECRET, code) hex — тот же формат, что в otp_codes.
    code_hash       VARCHAR(64) NOT NULL,

    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ NULL,
    attempts_count  INT         NOT NULL DEFAULT 0,
    ip_address      INET        NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- «Найти активный OTP user'а» + rate-limit «не чаще 1 в час».
CREATE INDEX IF NOT EXISTS idx_deletion_otp_user_created
    ON private_data.account_deletion_otp_codes (user_id, created_at DESC);
