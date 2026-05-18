-- ============================================================================
-- 004_magic_link_tokens.sql — токены входа по magic link
--   ТЗ §3.7.9: TTL 30 минут, одноразовые, отправляются на verified email
--   при попытке входа с нового устройства.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.magic_link_tokens (
    token       VARCHAR(64) PRIMARY KEY,
    user_id     UUID        NOT NULL
                            REFERENCES private_data.users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    ip_address  INET        NULL,                                              -- IP отправителя для аудита
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mlt_user_used
    ON private_data.magic_link_tokens (user_id, used_at);

CREATE INDEX IF NOT EXISTS idx_mlt_expires
    ON private_data.magic_link_tokens (expires_at);
