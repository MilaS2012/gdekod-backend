-- ============================================================================
-- 015_cloudpayments_fields.sql — поля для интеграции с CloudPayments
-- (ТЗ v16.1 §3.3.1, этап 7).
--
-- ТРИ БЛОКА:
--
-- 1. subscriptions.last_charge_at — время последнего УСПЕШНОГО списания.
--    Обновляется в pay/recurrent webhook'ах. Нужно для:
--      - GET /api/subscription/status (показать «последняя оплата DD.MM»)
--      - Аудит при разборе claims «не списали повторно»
--
-- 2. receipts.is_failed — маркер неудачного платежа.
--    INSERT с is_failed=true делает /webhook/cloudpayments/fail. Полезно для:
--      - Истории «ваши платежи» в ЛК (показывать failed серым)
--      - Аналитики (сколько раз карта не прошла)
--
-- 3. partial UNIQUE на (provider, provider_payment_id) — защита от race
--    при ретрае webhook'а CloudPayments. Без неё — два конкурентных INSERT
--    receipt'а с одним TransactionId могли бы создать дубль (есть SELECT-check,
--    но окно race ~10мс). UNIQUE закрывает окно: второй INSERT упадёт с 23505,
--    handler поймает и вернёт {code:0}.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. last_charge_at в subscriptions
-- ----------------------------------------------------------------------------

ALTER TABLE private_data.subscriptions
    ADD COLUMN IF NOT EXISTS last_charge_at TIMESTAMPTZ NULL;


-- ----------------------------------------------------------------------------
-- 2. is_failed в receipts
-- ----------------------------------------------------------------------------

ALTER TABLE private_data.receipts
    ADD COLUMN IF NOT EXISTS is_failed BOOLEAN NOT NULL DEFAULT false;

-- «Найти все failed-receipts конкретной подписки» — для разбора саппортом
-- и для UI «список неуспешных списаний». Partial — экономит место и
-- ускоряет lookup в типичной ситуации (99% receipt'ов — успешные).
CREATE INDEX IF NOT EXISTS idx_receipts_failed
    ON private_data.receipts (subscription_id, is_failed, created_at DESC)
    WHERE is_failed = true;


-- ----------------------------------------------------------------------------
-- 3. UNIQUE (provider, provider_payment_id) — idempotency защита от race
-- ----------------------------------------------------------------------------

-- Partial — потому что provider_payment_id NULL для receipt'ов от operator_mock
-- и других провайдеров без внешнего id. NULL ≠ NULL в UNIQUE, поэтому формально
-- partial не нужен, но явно ограничиваем для читаемости.
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_payment_id
    ON private_data.receipts (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
