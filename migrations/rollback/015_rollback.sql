-- ============================================================================
-- rollback 015 — снимает поля CloudPayments в обратном порядке.
--
-- Структура файла учитывает pg-mem quirk:
--   - DROP INDEX IF EXISTS работает безопасно на pg-mem и real PG, даже если
--     индекса/таблицы нет → оставляем как обычные statements.
--   - ALTER TABLE ... DROP COLUMN IF EXISTS требует чтобы таблица СУЩЕСТВОВАЛА
--     (IF EXISTS относится только к колонке) → оборачиваем в DO-блок с
--     проверкой information_schema.tables.
--   - pg-mem стрипает DO-блоки → на pg-mem колонки не дропаются, но это
--     ок: rollback-тесты проверяют что rollback-файлы ПРИМЕНИМЫ, не что
--     состояние БД после rollback идентично pre-migration.
-- ============================================================================

-- 3. UNIQUE на (provider, provider_payment_id) — partial index
DROP INDEX IF EXISTS private_data.idx_receipts_payment_id;

-- 2. partial index по failed-receipts
DROP INDEX IF EXISTS private_data.idx_receipts_failed;

-- ALTER TABLE statements в DO-блоке: пропускаем если таблица не существует
-- (актуально для теста rollback: 1-6 миграций → ВСЕ rollback'и, когда receipts
-- и subscriptions ещё не созданы).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'private_data' AND table_name = 'receipts'
    ) THEN
        -- 2. is_failed column
        ALTER TABLE private_data.receipts DROP COLUMN IF EXISTS is_failed;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'private_data' AND table_name = 'subscriptions'
    ) THEN
        -- 1. last_charge_at column
        ALTER TABLE private_data.subscriptions DROP COLUMN IF EXISTS last_charge_at;
    END IF;
END $$;
