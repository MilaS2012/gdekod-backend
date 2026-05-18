-- ============================================================================
-- 007_auth_sessions_ua_summary.sql — UI-метка устройства для GET /auth/sessions
--
-- user_agent_hash остаётся как PII-защитный идентификатор устройства
-- (используется для оповещения о смене устройства). user_agent_summary —
-- человекочитаемая метка "Chrome 120 on macOS", парсится из UA при
-- INSERT через lib/event.js parseUserAgent(). VARCHAR(100) с запасом.
-- ============================================================================

ALTER TABLE private_data.auth_sessions
    ADD COLUMN IF NOT EXISTS user_agent_summary VARCHAR(100) NULL;
