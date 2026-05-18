-- ============================================================================
-- 003_email_verify_tokens.sql — токены подтверждения email
--   ТЗ §3.7.5: TTL 24ч, одноразовые.
--   §3.7.5 шаг 7: при verify аннулируются все остальные неиспользованные
--   токены этого user_id — это делает приложение (UPDATE ... SET used_at).
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.email_verify_tokens (
    token       VARCHAR(64)  PRIMARY KEY,                                      -- base64url 32 байта (~43 символа), VARCHAR(64) с запасом
    user_id     UUID         NOT NULL
                             REFERENCES private_data.users(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ  NOT NULL,
    used_at     TIMESTAMPTZ  NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Для поиска неиспользованных токенов этого user_id (аннулирование при verify).
CREATE INDEX IF NOT EXISTS idx_evt_user_used
    ON private_data.email_verify_tokens (user_id, used_at);

-- Для cron-очистки протухших.
CREATE INDEX IF NOT EXISTS idx_evt_expires
    ON private_data.email_verify_tokens (expires_at);
