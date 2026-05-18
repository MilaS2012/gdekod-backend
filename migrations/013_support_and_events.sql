-- ============================================================================
-- 013_support_and_events.sql — обращения в поддержку и аналитический журнал
-- событий (ТЗ v16.1 §19.5, §21.2).
--
-- Две независимые таблицы:
--
-- 1. support_tickets — обращения юзера в саппорт. Лежат в private_data
--    (содержат ПД и текст переписки). Хранение по 152-ФЗ — без удаления;
--    закрытые тикеты остаются для аудита. Контактные данные (phone/email)
--    кладутся СНЭПШОТОМ на момент создания: если user потом сменит email,
--    в тикете останется тот, на который реально пойдёт ответ.
--
-- 2. events_log — аналитика поведения user'а (coupon_viewed, coupon_copied и
--    т.д.). Retention 6 месяцев — старые записи чистятся cron'ом из
--    lib/events-cleanup.js (вызов поднимается в этапе 6.10). Индекс по
--    created_at — главный, через него работает retention DELETE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.support_tickets (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL
                    REFERENCES private_data.users(id) ON DELETE CASCADE,

    category        VARCHAR(32)  NOT NULL,
    subject         VARCHAR(200) NOT NULL,
    message         TEXT         NOT NULL,

    status          VARCHAR(32)  NOT NULL DEFAULT 'open',

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ  NULL,

    -- Контактные данные на момент создания (snapshot).
    -- contact_phone — обязателен (он же first_class identifier user'а).
    -- contact_email — NULL, если у user'а на момент создания не было
    -- verified email.
    contact_phone   VARCHAR(20)  NOT NULL,
    contact_email   VARCHAR(255) NULL,

    CONSTRAINT st_category_check
      CHECK (category IN (
        'payment',       -- проблемы с оплатой
        'subscription',  -- управление подпиской
        'coupon',        -- жалоба на промокод (помимо complaint)
        'account',       -- проблемы со входом / привязкой email
        'feature',       -- предложение функции
        'other'          -- прочее
      )),
    CONSTRAINT st_status_check
      CHECK (status IN ('open', 'in_progress', 'closed', 'spam'))
);

-- Список «мои тикеты» в личном кабинете (свежие сверху).
CREATE INDEX IF NOT EXISTS idx_tickets_user_created
    ON private_data.support_tickets (user_id, created_at DESC);

-- Очередь админа («все открытые», сортировка по дате).
CREATE INDEX IF NOT EXISTS idx_tickets_status_created
    ON private_data.support_tickets (status, created_at DESC);


-- ----------------------------------------------------------------------------
-- events_log — аналитический журнал. ON DELETE SET NULL, потому что
-- удаление user'а по 152-ФЗ не должно тереть события — нам нужно знать,
-- что они БЫЛИ, но без привязки к личности.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS private_data.events_log (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NULL
                    REFERENCES private_data.users(id) ON DELETE SET NULL,

    event_type      VARCHAR(64)  NOT NULL,

    -- Контекст события (произвольный JSON). Размер ограничен на уровне
    -- handler'а (4000 байт после JSON.stringify) — БД CHECK не ставим,
    -- чтобы клиент-валидация была единой точкой контроля.
    payload         JSONB        NULL,

    -- Связанные сущности (для аналитики «топ-просмотренные купоны» и т.п.).
    -- Без FK на public_data — это аналитика, нам важно сохранить факт
    -- события даже если coupon/merchant удалили из витрины.
    coupon_id       BIGINT       NULL,
    merchant_id     BIGINT       NULL,

    -- Технический контекст для борьбы с ботами и анализа.
    -- user_agent_hash — SHA-256 от UA (PII-защищённая идентификация устройства,
    -- см. lib/event.js userAgentHash).
    ip_address      INET         NULL,
    user_agent_hash VARCHAR(64)  NULL,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Главный индекс — для retention cleanup (DELETE WHERE created_at < cutoff).
CREATE INDEX IF NOT EXISTS idx_events_created
    ON private_data.events_log (created_at);

-- Аналитика по конкретному user (история действий, поддержка).
CREATE INDEX IF NOT EXISTS idx_events_user_type
    ON private_data.events_log (user_id, event_type, created_at DESC);

-- Аналитика по типу событий («сколько было coupon_viewed за день»).
CREATE INDEX IF NOT EXISTS idx_events_type_created
    ON private_data.events_log (event_type, created_at DESC);
