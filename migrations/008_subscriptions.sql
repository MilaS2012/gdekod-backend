-- ============================================================================
-- 008_subscriptions.sql — таблица подписок (ТЗ v16.1 §3.3, §3.3.1, §3.3.2)
--
-- ★ КРИТИЧНО: тариф и провайдер строго связаны.
--   - daily_35    → ИСКЛЮЧИТЕЛЬНО operator_* (включая operator_mock на staging)
--   - monthly_499 → ИСКЛЮЧИТЕЛЬНО cloudpayments_card / cloudpayments_sbp
--
--   Кросс-комбинация — это:
--   - Технически нарушение разделения биллинга (CloudPayments не поддерживает
--     микро-платежи 35₽; оператор не подключён под месячные суммы)
--   - Юридически разные сценарии согласия пользователя (SMS-consent vs карта)
--   Блокируем на уровне БД через CHECK constraint subs_tariff_provider_match.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private_data.subscriptions (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID         NOT NULL
                                      REFERENCES private_data.users(id) ON DELETE CASCADE,
    tariff               VARCHAR(32)  NOT NULL,
    provider             VARCHAR(32)  NOT NULL,
    status               VARCHAR(32)  NOT NULL DEFAULT 'pending',

    -- Деньги (в копейках, чтобы избежать float-арифметики)
    amount_kopecks       INT          NOT NULL,
    currency             VARCHAR(8)   NOT NULL DEFAULT 'RUB',

    -- Жизненный цикл
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    activated_at         TIMESTAMPTZ  NULL,
    cancelled_at         TIMESTAMPTZ  NULL,
    expires_at           TIMESTAMPTZ  NULL,
    next_charge_at       TIMESTAMPTZ  NULL,

    -- Защита от мусорных значений
    CONSTRAINT subs_tariff_check
        CHECK (tariff IN ('daily_35', 'monthly_499')),

    CONSTRAINT subs_provider_check
        CHECK (provider IN (
            'operator_mock',
            'operator_megafon', 'operator_t2', 'operator_beeline',
            'cloudpayments_card', 'cloudpayments_sbp'
        )),

    CONSTRAINT subs_status_check
        CHECK (status IN (
            'pending', 'active', 'cancelled', 'expired',
            'paused_payment_failed', 'mock_terminated'
        )),
    -- status='mock_terminated' зарезервирован для будущего admin endpoint
    -- POST /api/admin/subscription/{id}/terminate. Не используется в 6.6.
    -- Реализация — этап 6.10 (если понадобится для команды тестирования).

    -- ★ Главный CHECK: разделение биллинга по тарифу
    CONSTRAINT subs_tariff_provider_match CHECK (
        (tariff = 'daily_35' AND provider IN (
            'operator_mock',
            'operator_megafon', 'operator_t2', 'operator_beeline'
        ))
        OR
        (tariff = 'monthly_499' AND provider IN (
            'cloudpayments_card', 'cloudpayments_sbp'
        ))
    )
);

-- «активные подписки этого user'а» — основной запрос
CREATE INDEX IF NOT EXISTS idx_subs_user_status
    ON private_data.subscriptions (user_id, status);

-- «кому пора списать?» — для cron / Cloud Functions Timer
CREATE INDEX IF NOT EXISTS idx_subs_next_charge
    ON private_data.subscriptions (next_charge_at)
    WHERE status = 'active';

-- ★ Только ОДНА активная подписка на user_id одновременно.
-- Cancelled / expired / pending — можно много (история).
CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_one_active_per_user
    ON private_data.subscriptions (user_id)
    WHERE status = 'active';
