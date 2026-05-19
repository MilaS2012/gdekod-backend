// =============================================================================
// events-config.js — аналитический журнал событий (ТЗ v16.1 §21.2).
//
// EVENT_TYPES — закрытый список того, что клиент может писать в /api/events.
// Незнакомые типы → 400 invalid_event_type. Это защита от мусора в журнале
// и фиксация контракта (аналитика знает, что есть в БД).
//
// EVENTS_RETENTION_DAYS — 6 месяцев по 152-ФЗ §21.2. Чистим cron'ом из
// lib/events-cleanup.js (cron-таймер поднимается в этапе 6.10).
//
// EVENTS_LIMITS — анти-спам на /events:
//   - PAYLOAD_MAX_BYTES: 4000 — типичный event-payload < 500 байт, 4КБ —
//     запас на странные случаи. Считаем по JSON.stringify(payload).length
//     (UTF-16 code units; для ASCII-payload'ов = байтам).
//   - EVENTS_PER_MINUTE: 60 — один user не может писать чаще раза в секунду
//     в среднем. Лимит в памяти (lib/events-rate-limit.js), не через БД.
// =============================================================================

export const EVENT_TYPES = Object.freeze([
    // Просмотры и взаимодействия
    'coupon_viewed',
    'coupon_copied',
    'merchant_viewed',
    'search_performed',

    // Авторизация (вспомогательные — основные логируются явно в auth-handler'ах)
    'session_started',
    'session_ended',

    // Подписка
    'subscription_page_viewed',
    'tariff_clicked',

    // ЛК
    'profile_viewed',
    'settings_opened',

    // Общие
    'page_viewed',
    'error_occurred',

    // 152-ФЗ audit trail (6.9). Эти события пишутся не клиентом через
    // /api/events, а напрямую серверными handler'ами (export, deletion-*,
    // cleanup). Включены в whitelist чтобы пройти валидацию /api/events
    // на случай, если клиент когда-нибудь захочет логировать их явно;
    // и чтобы события не падали при попытке клиента сделать это.
    'data_exported',
    'deletion_scheduled',
    'deletion_completed',
    'deletion_cancelled',
]);

export const EVENTS_RETENTION_DAYS = 180;

export const EVENTS_LIMITS = Object.freeze({
    PAYLOAD_MAX_BYTES:   4000,
    EVENTS_PER_MINUTE:   60,
});
