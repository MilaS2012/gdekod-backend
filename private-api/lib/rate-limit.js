// =============================================================================
// rate-limit.js — защита от спама OTP/magic-link (ТЗ §3.6, §3.7).
//
// Лимиты (см. константу LIMITS ниже):
//   SMS / Flash Call / Voice OTP:
//     - 1 запрос в 60 секунд на номер
//     - 5 запросов в сутки на номер
//     - 20 запросов в сутки с одного IP
//
//   Email magic link (для входа с нового устройства):
//     - 1 запрос в 60 секунд на пользователя
//     - 10 запросов в сутки на пользователя
//     Rate-limit по user_id (а не email): magic link отправляется только
//     когда user.email_verified_at IS NOT NULL — значит user уже в БД.
//
// Подсчёт через COUNT(*) с фильтром по created_at — без отдельной таблицы
// rate_limits. otp_codes и magic_link_tokens сами хранят историю
// попыток (записи живут до cron-очистки протухших).
//
// API:
//   smsRateCheck({ phone, ip }, { pool? })   → { allowed, reason?, retryAfterSeconds? }
//   emailRateCheck({ user_id }, { pool? })   → то же самое
//
// Возвращаемое значение:
//   { allowed: true }
//   { allowed: false, reason: 'cooldown',           retryAfterSeconds: 42 }
//   { allowed: false, reason: 'daily_limit_phone' }
//   { allowed: false, reason: 'daily_limit_ip' }
//   { allowed: false, reason: 'daily_limit_email' }
//
// retryAfterSeconds присутствует только для 'cooldown' — для дневных
// лимитов точное «когда снова можно» вычислить сложнее (нужно знать
// первый запрос окна), фронт показывает общее «попробуйте завтра».
// =============================================================================

import { getPool } from './db.js';

export const LIMITS = Object.freeze({
    SMS_COOLDOWN_SECONDS:    60,
    SMS_DAILY_PER_PHONE:     5,
    SMS_DAILY_PER_IP:        20,
    EMAIL_COOLDOWN_SECONDS:  60,
    EMAIL_DAILY_PER_USER:    10,
});

// -----------------------------------------------------------------------------
// smsRateCheck
// -----------------------------------------------------------------------------

/**
 * @param {{ phone: string, ip?: string|null }} input
 * @param {{ pool?: object }} [deps]
 * @returns {Promise<{ allowed: boolean, reason?: string, retryAfterSeconds?: number }>}
 */
export async function smsRateCheck({ phone, ip = null }, deps = {}) {
    const pool = deps.pool ?? getPool();
    if (typeof phone !== 'string' || phone.length === 0) {
        throw new Error('smsRateCheck: phone обязателен');
    }

    // ★ Порядок проверок (IP first → cooldown → daily/phone) подобран
    //   против ботнет-атак со случайными номерами: при таком сценарии
    //   per-phone проверки бесполезны (каждый раз новый phone), а
    //   daily/IP режет всё одним самым дешёвым запросом.

    // 1. Daily per IP — cheapest cutoff против ботнета.
    if (ip) {
        const ipDaily = await pool.query(
            `SELECT count(*)::int AS cnt
               FROM private_data.otp_codes
              WHERE ip_address = $1
                AND created_at > now() - interval '24 hours'`,
            [ip],
        );
        if (ipDaily.rows[0].cnt >= LIMITS.SMS_DAILY_PER_IP) {
            return { allowed: false, reason: 'daily_limit_ip' };
        }
    }

    // 2. Cooldown — последний OTP моложе 60 сек?
    const last = await pool.query(
        `SELECT created_at
           FROM private_data.otp_codes
          WHERE phone = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [phone],
    );
    if (last.rows.length > 0) {
        const ageSeconds = ageInSeconds(last.rows[0].created_at);
        if (ageSeconds < LIMITS.SMS_COOLDOWN_SECONDS) {
            return {
                allowed: false,
                reason: 'cooldown',
                retryAfterSeconds: LIMITS.SMS_COOLDOWN_SECONDS - ageSeconds,
            };
        }
    }

    // 3. Daily per phone — атака на конкретный номер.
    const phoneDaily = await pool.query(
        `SELECT count(*)::int AS cnt
           FROM private_data.otp_codes
          WHERE phone = $1
            AND created_at > now() - interval '24 hours'`,
        [phone],
    );
    if (phoneDaily.rows[0].cnt >= LIMITS.SMS_DAILY_PER_PHONE) {
        return { allowed: false, reason: 'daily_limit_phone' };
    }

    return { allowed: true };
}

// -----------------------------------------------------------------------------
// emailRateCheck
// -----------------------------------------------------------------------------

/**
 * @param {{ user_id: string }} input
 * @param {{ pool?: object }} [deps]
 * @returns {Promise<{ allowed: boolean, reason?: string, retryAfterSeconds?: number }>}
 */
export async function emailRateCheck({ user_id }, deps = {}) {
    const pool = deps.pool ?? getPool();
    if (typeof user_id !== 'string' || user_id.length === 0) {
        throw new Error('emailRateCheck: user_id обязателен');
    }

    // 1. Cooldown
    const last = await pool.query(
        `SELECT created_at
           FROM private_data.magic_link_tokens
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [user_id],
    );
    if (last.rows.length > 0) {
        const ageSeconds = ageInSeconds(last.rows[0].created_at);
        if (ageSeconds < LIMITS.EMAIL_COOLDOWN_SECONDS) {
            return {
                allowed: false,
                reason: 'cooldown',
                retryAfterSeconds: LIMITS.EMAIL_COOLDOWN_SECONDS - ageSeconds,
            };
        }
    }

    // 2. Daily per user
    const daily = await pool.query(
        `SELECT count(*)::int AS cnt
           FROM private_data.magic_link_tokens
          WHERE user_id = $1
            AND created_at > now() - interval '24 hours'`,
        [user_id],
    );
    if (daily.rows[0].cnt >= LIMITS.EMAIL_DAILY_PER_USER) {
        return { allowed: false, reason: 'daily_limit_email' };
    }

    return { allowed: true };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ageInSeconds(timestampLike) {
    const ms = timestampLike instanceof Date
        ? timestampLike.getTime()
        : new Date(timestampLike).getTime();
    return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}
