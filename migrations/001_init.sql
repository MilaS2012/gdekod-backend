-- ============================================================================
-- 001_init.sql — базовая инициализация БД (этап 6.2)
--
-- ★ Идемпотентна: безопасно прогонять на пустой БД и на проде, где
--   public_data.merchants/coupons уже созданы ручным DDL прошлых этапов.
-- ★ Закрывает DDL-долг public_data: до этой миграции SQL-схема прод-таблиц
--   жила только в Yandex Cloud, не в git.
--
-- Решения по типам id:
--   - public_data.merchants, public_data.coupons → BIGSERIAL
--     (матчится с тем, что уже в проде и с Number(m.id) в public-api/handlers/).
--   - private_data.users + все приватные токены/сессии → UUID
--     (генерируется через gen_random_uuid() из pgcrypto или из Node через
--     lib/id.js newId(), см. fallback ниже).
-- ============================================================================

-- Расширение для gen_random_uuid(). YC managed PG даёт право CREATE EXTENSION
-- pgcrypto. Если внезапно не сработает — переключимся на UUID-генерацию
-- в Node (private-api/lib/id.js newId()) с убранным DEFAULT.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Схемы
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS public_data;
CREATE SCHEMA IF NOT EXISTS private_data;

-- ----------------------------------------------------------------------------
-- Общая plpgsql-функция для триггера updated_at.
-- Лежит в private_data — используется только private-таблицами.
-- ★ Поведение триггера тестируем на реальном PG в этапе 6.10
--   (pg-mem имеет ограниченную поддержку plpgsql).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private_data.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- public_data.merchants  (реверс с public-api/handlers/merchants-*.js)
--   Колонки, которые читает прод-код:
--     id, name, domain (для slug через split_part), logo_url, category,
--     is_active, created_at
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_data.merchants (
    id          BIGSERIAL    PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    domain      VARCHAR(255) NOT NULL,
    logo_url    TEXT         NULL,
    category    VARCHAR(64)  NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchants_active_category
    ON public_data.merchants (category)
    WHERE is_active = true;

-- ----------------------------------------------------------------------------
-- public_data.coupons  (реверс с public-api/handlers/coupons-*.js)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_data.coupons (
    id              BIGSERIAL    PRIMARY KEY,
    merchant_id     BIGINT       NOT NULL
                                 REFERENCES public_data.merchants(id) ON DELETE CASCADE,
    description     TEXT         NOT NULL,
    discount        VARCHAR(64)  NOT NULL,
    code            VARCHAR(128) NOT NULL,
    status          VARCHAR(32)  NOT NULL DEFAULT 'active',
    last_checked_at TIMESTAMPTZ  NULL,
    expires_at      TIMESTAMPTZ  NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupons_merchant_status
    ON public_data.coupons (merchant_id, status);

CREATE INDEX IF NOT EXISTS idx_coupons_last_checked
    ON public_data.coupons (last_checked_at DESC NULLS LAST);

-- Для парсера (tiered scheduling, §20 ТЗ):
-- «какие активные купоны проверять следующими» — сортировка по last_checked_at
-- с NULL впереди (никогда не проверенные имеют приоритет).
CREATE INDEX IF NOT EXISTS idx_coupons_status_checked
    ON public_data.coupons (status, last_checked_at NULLS FIRST)
    WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- private_data.users  (по ответу B этапа 6.2)
--   phone_verified_at NOT NULL DEFAULT now() — запись создаётся только
--   после успешного OTP, значит phone уже верифицирован.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private_data.users (
    id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    phone                  VARCHAR(20)  NOT NULL UNIQUE,
    phone_verified_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deletion_requested_at  TIMESTAMPTZ  NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Триггер updated_at. CREATE TRIGGER не поддерживает IF NOT EXISTS,
-- поэтому DROP+CREATE для идемпотентности.
DROP TRIGGER IF EXISTS trg_users_updated_at ON private_data.users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON private_data.users
    FOR EACH ROW
    EXECUTE FUNCTION private_data.set_updated_at();
