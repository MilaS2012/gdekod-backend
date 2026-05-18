// =============================================================================
// coupon-config.js — пороги для голосов и триггеры парсера (ТЗ §20.4 v16.1).
//
// При накоплении complaints на coupon:
//   - REPRIORITIZE (3) → парсер ставит coupon в urgent-queue (6.8)
//   - AUTO_EXPIRE  (5) → status='expired', снимаем с витрины
//   - BLOCK_MERCHANT (10) → ручной разбор админом (НЕ автоматическая блокировка)
//
// VOTE_COOLDOWN_HOURS — пользователь не может голосовать (confirm/complaint)
// за один coupon чаще 1 раза в 24 часа. Защита от спама.
// =============================================================================

export const COMPLAINT_THRESHOLDS = Object.freeze({
    REPRIORITIZE:    3,
    AUTO_EXPIRE:     5,
    BLOCK_MERCHANT:  10,
});

export const VOTE_COOLDOWN_HOURS = 24;
