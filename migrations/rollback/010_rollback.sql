-- ============================================================================
-- rollback 010 — снимает coupon_votes, coupon_reveals и счётчики из coupons.
-- ============================================================================

-- private_data tables
DROP INDEX IF EXISTS private_data.idx_cr_unique_user_coupon;
DROP INDEX IF EXISTS private_data.idx_cr_user_revealed;
DROP TABLE IF EXISTS private_data.coupon_reveals CASCADE;

DROP INDEX IF EXISTS private_data.idx_cv_coupon_type_recent;
DROP INDEX IF EXISTS private_data.idx_cv_user_coupon_recent;
DROP TABLE IF EXISTS private_data.coupon_votes CASCADE;

-- Счётчики из public_data.coupons
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS last_complaint_at;
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS complaint_count;
ALTER TABLE public_data.coupons DROP COLUMN IF EXISTS confirmed_count;
