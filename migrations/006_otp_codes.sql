-- ============================================================================
-- 006_otp_codes.sql — OTP-коды для SMS / Flash Call / Voice
--
-- code_hash = HMAC-SHA256(OTP_HMAC_SECRET, code) в hex (64 символа).
-- Plain-код в БД не хранится никогда (ответ C2 этапа 6.2).
--
-- ★ В этой таблице НЕТ FK на private_data.users. OTP создаётся при первой
--   попытке входа — пользователя в users ещё может не быть. Связь по phone.
--   При DELETE user его otp_codes остаются как история попыток.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.otp_codes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone           VARCHAR(20) NOT NULL,                                       -- E.164, нет FK (см. шапку)
    code_hash       VARCHAR(64) NOT NULL,                                       -- HMAC-SHA256 hex
    channel         VARCHAR(16) NOT NULL
                    CHECK (channel IN ('sms', 'flash_call', 'voice')),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ NULL,
    attempts_count  INT         NOT NULL DEFAULT 0,
    ip_address      INET        NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- «Найти живой OTP для этого номера».
CREATE INDEX IF NOT EXISTS idx_otp_phone_expires
    ON private_data.otp_codes (phone, expires_at);

-- Для rate-limit: «сколько OTP создано с этого IP/телефона за окно».
CREATE INDEX IF NOT EXISTS idx_otp_created
    ON private_data.otp_codes (created_at);

-- Один активный OTP на номер ВООБЩЕ (не на номер+канал).
-- Решение по тесту 22: если пользователь нажимает «SMS» после Flash Call —
-- старый OTP должен быть аннулирован (UPDATE used_at = now()) до INSERT
-- нового. Это убирает путаницу: какой код вводить.
--
-- Конструкция WHERE used_at IS NULL — immutable, корректна для partial unique.
-- (Вариант WHERE expires_at > now() невозможен — now() не immutable.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_otp_one_active_per_phone
    ON private_data.otp_codes (phone)
    WHERE used_at IS NULL;
