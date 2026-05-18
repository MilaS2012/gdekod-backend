-- ============================================================================
-- ⚠️  КРИТИЧНО: ЭТОТ ROLLBACK ТОЛЬКО ДЛЯ ТЕСТОВ И DEV.
--
-- На production он удалит ВСЁ — включая работающую public_data.merchants
-- и public_data.coupons со всеми промокодами.
--
-- Если нужен реальный rollback на проде:
--   1. Сначала DROP только private_data.users (CASCADE подчистит токены/сессии)
--   2. Дальше точечный SQL по необходимости
--   3. public_data НЕ ТРОГАТЬ — она была до этой миграции и должна
--      остаться после.
--
-- Этот файл оставлен для симметрии с другими миграциями и для CI-тестов
-- round-trip (apply → rollback → apply снова).
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '⚠️  rollback 001 удалит ВСЕ таблицы public_data и private_data.';
    RAISE NOTICE '⚠️  Только для тестов и dev. Не запускать на production.';
END
$$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON private_data.users;
DROP TABLE   IF EXISTS private_data.users    CASCADE;
DROP TABLE   IF EXISTS public_data.coupons   CASCADE;
DROP TABLE   IF EXISTS public_data.merchants CASCADE;
DROP FUNCTION IF EXISTS private_data.set_updated_at();

-- Схемы public_data, private_data и расширение pgcrypto оставляем — могут
-- использоваться другими частями системы.
