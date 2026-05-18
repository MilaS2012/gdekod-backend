-- ============================================================================
-- 005_auth_sessions.sql — JWT-сессии с возможностью отзыва (ответ D1, §3.6)
--
-- session_id — единственный идентификатор сессии, кладётся в JWT как sid.
-- В payload JWT: { sub: user_id, sid: session_id, iat, exp }.
-- Отзыв: UPDATE ... SET revoked_at = now() WHERE session_id = $1
-- logout-all: UPDATE ... SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL
--
-- user_agent_hash — SHA-256(UA) hex. Сам UA не храним: он PII-light
-- (можно деанонимизировать), плюс по хешу мы можем на лету парсить
-- в "Chrome on macOS" через ua-parser-js, если фронту понадобится показать.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.auth_sessions (
    session_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL
                                 REFERENCES private_data.users(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ NULL,
    last_used_at     TIMESTAMPTZ NULL,
    ip_address       INET        NULL,
    user_agent_hash  VARCHAR(64) NULL
);

-- «Активные сессии этого пользователя» — для logout-all и для списка устройств.
CREATE INDEX IF NOT EXISTS idx_sessions_user_revoked
    ON private_data.auth_sessions (user_id, revoked_at);

-- Для cron-очистки протухших.
CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON private_data.auth_sessions (expires_at);

-- Главный запрос приватного API: проверка JWT при каждом запросе.
-- "SELECT ... WHERE session_id=$1 AND revoked_at IS NULL AND expires_at > now()"
-- Partial index по session_id WHERE revoked_at IS NULL даёт минимальный
-- index footprint для самой частой операции.
CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON private_data.auth_sessions (session_id)
    WHERE revoked_at IS NULL;
