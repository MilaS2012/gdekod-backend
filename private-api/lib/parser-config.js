// =============================================================================
// parser-config.js — конфигурация tiered scheduling и urgent-queue для парсера
// (ТЗ v16.1 §20.2, §20.3).
//
// Парсер живёт в Azure (Container Instances + Playwright) и периодически
// запрашивает у backend список coupons для проверки. Этот модуль задаёт,
// как часто перепроверять каждый tier и что считать «срочным».
// =============================================================================

// Интервал перепроверки по tier. Чем «горячее» tier, тем чаще.
export const TIER_INTERVALS_HOURS = Object.freeze({
    1: 3,    // top-100: каждые 3 часа
    2: 8,    // следующие 500: каждые 8 часов
    3: 24,   // остальные: каждые 24 часа
});

// Размер каждого tier (для аналитики и админ-дашборда; на /coupons-list
// ограничение по tier приходит из CHECK ниже + ORDER BY).
export const TIER_LIMITS = Object.freeze({
    1: 100,
    2: 500,
    3: 10_000,
});

// Urgent: coupon с жалобами перепроверяется не чаще 1 раза в 30 минут,
// чтобы парсер не дёргал один и тот же магазин в цикле.
export const URGENT_RECHECK_INTERVAL_MINUTES = 30;

// Допустимые status'ы в POST /api/admin/parser/result.
export const PARSE_RESULT_STATUSES = Object.freeze([
    'active',         // код работает
    'expired',        // код истёк
    'invalid',        // код не работает (но не «истёк»)
    'not_found',      // страница магазина 404 — возможно редизайн/закрытие
    'parsing_error',  // ошибка парсера — НЕ значит, что код плохой
]);

export const VALID_TIERS = Object.freeze([1, 2, 3]);
