-- ============================================================================
-- rollback 012 — снимает поля и индексы парсера.
-- ============================================================================

DROP INDEX IF EXISTS public_data.idx_coupons_urgent;
DROP INDEX IF EXISTS public_data.idx_coupons_tier_lastcheck;

ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS last_parse_error;
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS last_parse_status;
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS last_successful_check_at;
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS tier;
