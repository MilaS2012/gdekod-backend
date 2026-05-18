// =============================================================================
// events-rate-limit.js — in-memory rate-limit для POST /api/events.
//
// Аналитические события — частая операция (десятки в минуту от активного
// user'а). Считать через БД на каждый вызов = COUNT(*) на горячем пути,
// что бессмысленно для аналитики. Поэтому — счётчик в памяти Cloud Function.
//
// ★ Trade-off: память сбрасывается при cold-start функции, значит
//   реальный лимит — «60 событий за минуту от user'а на тот инстанс».
//   Yandex Cloud Functions может держать несколько горячих инстансов,
//   так что атакующий потенциально может писать в N × 60 событий/мин.
//   Для аналитического журнала это приемлемо — это защита от
//   очевидных багов клиента (бесконечный цикл записи), а не от
//   таргетированного DoS (от него защищаемся API Gateway-лимитами).
//
// Окно фиксированное (не sliding). Когда window_start + 60s истекло —
// сбрасываем counter в 0. Это упрощает реализацию (один Map) и в среднем
// даёт правильный пропускной поток (60 events/мин); крайние случаи на
// границах окон тут не критичны.
//
// API:
//   checkEventRate(user_id) → { allowed: true }
//                           | { allowed: false, retryAfterSeconds: int }
//   __resetCountersForTest()  — только для тестов
// =============================================================================

import { EVENTS_LIMITS } from './events-config.js';

const WINDOW_MS = 60 * 1000;

/** @type {Map<string, { count: number, window_start: number }>} */
const counters = new Map();

/**
 * Проверяет, можно ли записать ещё одно событие для user_id.
 * Если можно — инкрементирует счётчик и возвращает { allowed: true }.
 * Если нет — возвращает retryAfterSeconds (сколько ждать до сброса окна).
 *
 * @param {string} user_id
 * @returns {{ allowed: boolean, retryAfterSeconds?: number }}
 */
export function checkEventRate(user_id) {
    if (typeof user_id !== 'string' || user_id.length === 0) {
        throw new Error('checkEventRate: user_id обязателен');
    }

    const now  = Date.now();
    const cell = counters.get(user_id);

    // Нет записи или окно истекло — новое окно.
    if (cell == null || (now - cell.window_start) >= WINDOW_MS) {
        counters.set(user_id, { count: 1, window_start: now });
        return { allowed: true };
    }

    if (cell.count >= EVENTS_LIMITS.EVENTS_PER_MINUTE) {
        const elapsedMs   = now - cell.window_start;
        const remainingMs = Math.max(0, WINDOW_MS - elapsedMs);
        return {
            allowed: false,
            retryAfterSeconds: Math.ceil(remainingMs / 1000),
        };
    }

    cell.count += 1;
    return { allowed: true };
}

/** Только для тестов: очищает все счётчики. */
export function __resetCountersForTest() {
    counters.clear();
}
