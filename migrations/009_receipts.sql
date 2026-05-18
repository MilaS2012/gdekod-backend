-- ============================================================================
-- 009_receipts.sql — чеки (фискальные документы и mock-маркеры).
--
-- На production будут создаваться:
--   - Webhook от CloudPayments → receipt с provider_payment_id и
--     provider_receipt_url (ссылка на чек ОФД)
--   - Webhook от оператора связи → receipt с is_mock=false
--
-- На staging:
--   - mock-cron создаёт receipts с is_mock=true и provider='operator_mock',
--     эмулируя ежедневные списания
--
-- subscription_id NULLABLE с ON DELETE SET NULL — чтобы при удалении
-- подписки чеки оставались (юр. требование — храним 6 месяцев минимум).
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.receipts (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID         NOT NULL
                                      REFERENCES private_data.users(id) ON DELETE CASCADE,
    subscription_id      UUID         NULL
                                      REFERENCES private_data.subscriptions(id) ON DELETE SET NULL,

    -- Сумма
    amount_kopecks       INT          NOT NULL,
    currency             VARCHAR(8)   NOT NULL DEFAULT 'RUB',
    provider             VARCHAR(32)  NOT NULL,

    -- Идентификаторы у провайдера (для сверки и аудита)
    provider_payment_id  VARCHAR(255) NULL,
    provider_receipt_url TEXT         NULL,

    -- ★ Маркер для staging: true → списания не было, эмуляция
    is_mock              BOOLEAN      NOT NULL DEFAULT false,

    -- Период за который оплачено
    period_start         TIMESTAMPTZ  NOT NULL,
    period_end           TIMESTAMPTZ  NOT NULL,

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- «история чеков этого user'а» — для /api/account/receipts
CREATE INDEX IF NOT EXISTS idx_receipts_user_created
    ON private_data.receipts (user_id, created_at DESC);

-- «все чеки этой подписки»
CREATE INDEX IF NOT EXISTS idx_receipts_subscription
    ON private_data.receipts (subscription_id);
