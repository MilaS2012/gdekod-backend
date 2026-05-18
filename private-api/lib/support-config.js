// =============================================================================
// support-config.js — категории тикетов и лимиты на создание (ТЗ v16.1 §19.5).
//
// TICKET_CATEGORIES синхронизирован с CHECK constraint миграции 013.
// При изменении набора — миграция + код одновременно.
//
// TICKET_LIMITS — анти-спам пороги на создание. Через БД-COUNT (а не
// in-memory): создание тикета — редкая операция, COUNT по индексу
// idx_tickets_user_created быстрый.
// =============================================================================

export const TICKET_CATEGORIES = Object.freeze([
    'payment',
    'subscription',
    'coupon',
    'account',
    'feature',
    'other',
]);

export const TICKET_STATUSES = Object.freeze([
    'open',
    'in_progress',
    'closed',
    'spam',
]);

export const TICKET_LIMITS = Object.freeze({
    SUBJECT_MAX_LENGTH:    200,
    MESSAGE_MIN_LENGTH:    10,
    MESSAGE_MAX_LENGTH:    5000,
    TICKETS_PER_HOUR:      2,
    TICKETS_PER_DAY:       5,
});
