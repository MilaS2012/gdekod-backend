-- ============================================================================
-- 012_parser_fields.sql — поля для парсера: tier, статус последней проверки,
-- индексы для tiered scheduling и urgent-queue (ТЗ §20.2, §20.3).
-- ============================================================================

-- Уровень приоритета проверки. Default 3 (раз в 24 часа).
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS tier INT NOT NULL DEFAULT 3;

-- Время последней УСПЕШНОЙ проверки (отдельно от last_checked_at, который
-- обновляется при любой попытке — даже при parsing_error).
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS last_successful_check_at TIMESTAMPTZ NULL;

-- Парсер пишет в эти поля детали последней проверки — для дашборда и отладки.
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS last_parse_status VARCHAR(32) NULL;

ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS last_parse_error TEXT NULL;

-- ---- Индексы ----------------------------------------------------------------
-- Tier scheduling: «coupons этого tier, которым пора перепровериться».
-- NULLS FIRST — никогда не проверенные имеют приоритет.
CREATE INDEX IF NOT EXISTS idx_coupons_tier_lastcheck
    ON public_data.coupons (tier, last_checked_at NULLS FIRST)
    WHERE status = 'active';

-- Urgent-queue: coupons с жалобами, не проверенные давно.
-- Partial WHERE complaint_count >= 3 AND status='active' — минимальный footprint.
CREATE INDEX IF NOT EXISTS idx_coupons_urgent
    ON public_data.coupons (complaint_count DESC, last_checked_at NULLS FIRST)
    WHERE status = 'active' AND complaint_count >= 3;
