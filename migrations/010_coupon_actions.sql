-- ============================================================================
-- 010_coupon_actions.sql — голоса и история раскрытий промокодов (ТЗ §3.7, §20.4)
--
-- Две новые таблицы в private_data + три новые колонки в public_data.coupons
-- для счётчиков голосов.
--
-- coupon_id хранится как BIGINT без FK на public_data.coupons (могут быть в
-- разных БД в будущем). Парсер обновляет public_data, handler-ы обновляют
-- private_data — связь логическая, не constraint.
-- ============================================================================

-- ---- Голоса (confirm/complaint) ---------------------------------------------
CREATE TABLE IF NOT EXISTS private_data.coupon_votes (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL
                              REFERENCES private_data.users(id) ON DELETE CASCADE,
    coupon_id     BIGINT      NOT NULL,
    vote_type     VARCHAR(16) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT cv_vote_type_check
        CHECK (vote_type IN ('confirm', 'complaint'))
);

-- Cooldown «1 голос на (user, coupon) в 24 часа» проверяется в коде,
-- индекс — для быстрого LIMIT 1 lookup.
CREATE INDEX IF NOT EXISTS idx_cv_user_coupon_recent
    ON private_data.coupon_votes (user_id, coupon_id, created_at DESC);

-- Для парсера: «жалобы на этот coupon за последний час/день».
CREATE INDEX IF NOT EXISTS idx_cv_coupon_type_recent
    ON private_data.coupon_votes (coupon_id, vote_type, created_at DESC);


-- ---- История раскрытий пользователем ---------------------------------------
CREATE TABLE IF NOT EXISTS private_data.coupon_reveals (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL
                              REFERENCES private_data.users(id) ON DELETE CASCADE,
    coupon_id     BIGINT      NOT NULL,
    revealed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Для /api/account/coupons — выборка истории с сортировкой.
CREATE INDEX IF NOT EXISTS idx_cr_user_revealed
    ON private_data.coupon_reveals (user_id, revealed_at DESC);

-- ★ Один user может «раскрыть» один coupon один раз — повторный POST
-- к /reveal не создаёт новую запись (ON CONFLICT DO NOTHING в handler).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_unique_user_coupon
    ON private_data.coupon_reveals (user_id, coupon_id);


-- ---- Счётчики голосов в public_data.coupons --------------------------------
-- Парсер читает эти поля, чтобы решать, какие coupons перепроверять
-- (urgent-queue) и какие пора снять с витрины.
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS confirmed_count   INT          NOT NULL DEFAULT 0;
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS complaint_count   INT          NOT NULL DEFAULT 0;
ALTER TABLE public_data.coupons
    ADD COLUMN IF NOT EXISTS last_complaint_at TIMESTAMPTZ  NULL;
