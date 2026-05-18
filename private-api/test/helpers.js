// =============================================================================
// helpers.js — фабрики и утилиты для интеграционных тестов.
//
// Используется тестами авторизации (6.3.2+), rate-limit (6.3.3+) и
// auth-handler'ами (6.3.4+). Даёт pg-mem-pool, совместимый по API с
// настоящим pg.Pool, плюс фабрики тестовых users / sessions.
//
// ★ Все обходы pg-mem 3.x (плагин plpgsql, gen_random_uuid и т.д.) —
//   те же, что и в test/migrations.test.js. Документация — там в шапке.
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { newDb, DataType } from 'pg-mem';

import { signJwt } from '../lib/jwt.js';
import { hashOtpCode } from '../lib/otp.js';
import { generateRandomToken } from '../lib/tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function stripUnsupportedForPgMem(sql) {
    return sql
        .replace(/CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]*?\$\$;/gi, '')
        .replace(/DO\s*\$\$[\s\S]*?\$\$\s*;/gi, '')
        .replace(/CREATE\s+TRIGGER[\s\S]*?;/gi, '')
        .replace(/DROP\s+TRIGGER[\s\S]*?;/gi, '')
        .replace(/DROP\s+FUNCTION[\s\S]*?;/gi, '');
}

/**
 * Создаёт свежий pg-mem-pool с применёнными миграциями 001-006.
 * Возвращает объект, совместимый по `.query(sql, params)` с pg.Pool.
 */
export async function newPgMemPool() {
    const db = newDb();
    db.public.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        implementation: () => randomUUID(),
        impure: true,
    });
    db.registerExtension('pgcrypto', () => {});

    const files = (await fs.readdir(MIGRATIONS_DIR))
        .filter(f => /^\d{3}_.*\.sql$/.test(f))
        .sort();
    for (const f of files) {
        const sql = stripUnsupportedForPgMem(await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8'));
        db.public.none(sql);
    }

    // ★ pg-mem 3.x quirk: partial unique index `WHERE used_at IS NULL`
    //   на otp_codes(phone) ломает SELECT-запросы `WHERE phone = $1`.
    //   Планировщик pg-mem ошибочно применяет index-WHERE-условие ко
    //   всем запросам, использующим колонку из индекса, даже когда в
    //   SELECT нет фильтра по used_at.
    //
    //   В реальном Postgres такого нет (проверим в этапе 6.10).
    //
    //   Поведение самого partial unique проверяется в test/migrations.test.js,
    //   где используется отдельный freshDb() без adapter'а. Здесь индекс
    //   функционально не нужен — тесты rate-limit и handler'ов имитируют
    //   сценарии, в которых старые OTP уже used_at-помечены.
    db.public.none('DROP INDEX private_data.idx_otp_one_active_per_phone');

    // ★ Тот же баг для idx_subs_one_active_per_user (status='active'):
    //   SELECT WHERE user_id=$1 без фильтра по status находит 0 rows для
    //   pending/cancelled подписок. На реальном PG этого нет.
    db.public.none('DROP INDEX private_data.idx_subs_one_active_per_user');

    const { Pool } = db.adapters.createPg();
    return new Pool();
}

/**
 * Создаёт пользователя с случайным уникальным phone.
 * Возвращает { user_id, phone }.
 */
export async function createTestUser(pool, phone = null) {
    const p = phone ?? `+7926${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
    const { rows } = await pool.query(
        `INSERT INTO private_data.users (phone) VALUES ($1) RETURNING id, phone`,
        [p],
    );
    return { user_id: rows[0].id, phone: rows[0].phone };
}

/**
 * Создаёт сессию для user_id и подписывает соответствующий JWT.
 * opts:
 *   - revoked:   boolean (default false) — поставить revoked_at = now()
 *   - expired:   boolean (default false) — поставить expires_at в прошлое
 *   - jwtSubOverride: string (опц.) — какой sub класть в JWT
 *       (для теста session_mismatch — sub != session.user_id)
 * Возвращает { session_id, jwt, expires_at, revoked_at }.
 */
export async function createTestSession(pool, user_id, opts = {}) {
    const {
        revoked = false,
        expired = false,
        jwtSubOverride = null,
    } = opts;

    // expires_at: если expired=true → в прошлом (-1 час), иначе +90 дней
    const expiresSql = expired
        ? `now() - interval '1 hour'`
        : `now() + interval '90 days'`;
    const revokedSql = revoked ? `now()` : `NULL`;

    const { rows } = await pool.query(
        `INSERT INTO private_data.auth_sessions (user_id, expires_at, revoked_at)
         VALUES ($1, ${expiresSql}, ${revokedSql})
         RETURNING session_id, expires_at, revoked_at`,
        [user_id],
    );
    const session_id = rows[0].session_id;

    const jwtSub = jwtSubOverride ?? user_id;
    // JWT_TTL — заведомо в будущем, отдельно от expires_at сессии,
    // чтобы можно было выдать "ещё живой" JWT под "уже истёкшую" сессию.
    const jwt = await signJwt({ sub: jwtSub, sid: session_id }, { ttlSeconds: 3600 });

    return {
        session_id,
        jwt,
        expires_at: rows[0].expires_at,
        revoked_at: rows[0].revoked_at,
    };
}

/**
 * Удобный helper для построения event-объекта Cloud Functions
 * с Bearer-токеном в заголовке.
 */
export function eventWithBearer(token) {
    return { headers: { authorization: token == null ? undefined : `Bearer ${token}` } };
}

/**
 * Вставляет «использованный» OTP-запись для тестов rate-limit.
 * used_at = now() выставляется обязательно — иначе сорвётся partial unique
 * на phone (один активный OTP на номер).
 *
 * createdAtOffsetSeconds — сколько секунд НАЗАД от now() (положительное число).
 */
export async function insertUsedOtp(pool, { phone, ip = null, createdAtOffsetSeconds = 0 }) {
    const created = new Date(Date.now() - createdAtOffsetSeconds * 1000);
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query(
        `INSERT INTO private_data.otp_codes
           (phone, code_hash, channel, expires_at, ip_address, created_at, used_at)
         VALUES ($1, 'h', 'sms', $2, $3, $4, now())`,
        [phone, expires, ip, created],
    );
}

/**
 * Вставляет «использованный» magic-link-токен для тестов rate-limit.
 */
export async function insertUsedMagicLink(pool, { user_id, createdAtOffsetSeconds = 0 }) {
    const created = new Date(Date.now() - createdAtOffsetSeconds * 1000);
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    // Уникальный токен на каждую запись.
    const token = `mock-${randomUUID()}`;
    await pool.query(
        `INSERT INTO private_data.magic_link_tokens
           (token, user_id, expires_at, created_at, used_at)
         VALUES ($1, $2, $3, $4, now())`,
        [token, user_id, expires, created],
    );
}

/**
 * Минимальный JWT_SECRET ≥ 32 символов для тестов. Идемпотентно
 * выставляет env в одно и то же значение — JWT, подписанные в разных
 * тестах, можно проверять одним секретом.
 */
export const TEST_JWT_SECRET      = 'test-jwt-secret-min-32-bytes-AAAAAAAA';
export const TEST_OTP_HMAC_SECRET = 'test-otp-hmac-secret-min-32-bytes-AAAA';

export function setTestJwtSecret() {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}
export function resetTestJwtSecret() {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}

/** Выставляет ВСЕ секреты, нужные auth-handler'у. */
export function setTestAuthSecrets() {
    setTestJwtSecret();
    process.env.OTP_HMAC_SECRET = TEST_OTP_HMAC_SECRET;
}
export function resetTestAuthSecrets() {
    resetTestJwtSecret();
    delete process.env.OTP_HMAC_SECRET;
}

/** Помечает email пользователя как verified (для тестов magic-link ветки). */
export async function markUserEmailVerified(pool, user_id, email) {
    await pool.query(
        `UPDATE private_data.users
            SET email = $2, email_verified_at = now()
          WHERE id = $1`,
        [user_id, email],
    );
}

/**
 * Создаёт подписку для тестов /subscription/*.
 *
 * opts:
 *   - tariff:     'daily_35' | 'monthly_499' (default 'daily_35')
 *   - provider:   default 'operator_mock' для daily_35, 'cloudpayments_card' для monthly_499
 *   - status:     'active' (default) | 'pending' | 'cancelled' | 'expired'
 *   - amount_kopecks: default 3500 для daily, 49900 для monthly
 *   - nextChargeOffsetSeconds: смещение next_charge_at от now() (отрицательное = в прошлом)
 *
 * Возвращает { id, status, ... }.
 */
export async function createTestSubscription(pool, user_id, opts = {}) {
    const {
        tariff = 'daily_35',
        provider = tariff === 'daily_35' ? 'operator_mock' : 'cloudpayments_card',
        status = 'active',
        amount_kopecks = tariff === 'daily_35' ? 3500 : 49900,
        nextChargeOffsetSeconds = 86_400,
    } = opts;

    const now           = new Date();
    const expiresAt     = status === 'active' || status === 'cancelled'
        ? new Date(now.getTime() + 86_400 * 1000)
        : null;
    const activatedAt   = status === 'active' || status === 'cancelled' ? now : null;
    const cancelledAt   = status === 'cancelled' ? now : null;
    const nextChargeAt  = status === 'active'
        ? new Date(now.getTime() + nextChargeOffsetSeconds * 1000)
        : null;

    const { rows } = await pool.query(
        `INSERT INTO private_data.subscriptions
           (user_id, tariff, provider, status, amount_kopecks,
            activated_at, cancelled_at, expires_at, next_charge_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, status, tariff, provider, amount_kopecks,
                   activated_at, expires_at, next_charge_at`,
        [user_id, tariff, provider, status, amount_kopecks,
         activatedAt, cancelledAt, expiresAt, nextChargeAt],
    );
    return rows[0];
}

/**
 * Создаёт магазин в public_data.merchants для тестов промокодов.
 * Возвращает { id, name, domain, ... }.
 */
export async function createTestMerchant(pool, opts = {}) {
    const {
        name     = 'Test Merchant',
        domain   = `test-merchant-${randomUUID().slice(0, 8)}.example`,
        category = 'other',
        logo_url = null,
    } = opts;
    const { rows } = await pool.query(
        `INSERT INTO public_data.merchants (name, domain, category, logo_url, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, name, domain, category, logo_url`,
        [name, domain, category, logo_url],
    );
    return rows[0];
}

/**
 * Создаёт промокод в public_data.coupons. Если merchant_id не передан —
 * создаёт нового merchant.
 *
 * opts:
 *   - merchant_id: BIGINT
 *   - description: string (default 'Test coupon')
 *   - discount:    string (default '-10%')
 *   - code:        string (default 'TEST10')
 *   - status:      'active' (default) | 'expired' | ...
 *   - expires_at:  Date | null (default +30 дней)
 *   - confirmed_count / complaint_count: int (default 0)
 *
 * Возвращает { id, code, status, merchant_id, ... }.
 */
export async function createTestCoupon(pool, opts = {}) {
    let merchant_id = opts.merchant_id;
    if (merchant_id == null) {
        merchant_id = (await createTestMerchant(pool)).id;
    }
    const {
        description = 'Test coupon',
        discount    = '-10%',
        code        = 'TEST10',
        status      = 'active',
        expires_at  = new Date(Date.now() + 30 * 24 * 3600 * 1000),
        confirmed_count = 0,
        complaint_count = 0,
    } = opts;
    const { rows } = await pool.query(
        `INSERT INTO public_data.coupons
           (merchant_id, description, discount, code, status,
            expires_at, confirmed_count, complaint_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, merchant_id, description, discount, code, status,
                   expires_at, confirmed_count, complaint_count`,
        [merchant_id, description, discount, code, status,
         expires_at, confirmed_count, complaint_count],
    );
    return rows[0];
}

/** Помечает email пользователя как привязанный, но НЕ verified. */
export async function attachUnverifiedEmail(pool, user_id, email) {
    await pool.query(
        `UPDATE private_data.users
            SET email = $2, email_verified_at = NULL
          WHERE id = $1`,
        [user_id, email],
    );
}

/**
 * Создаёт email-verify токен в БД для тестов /auth/email/verify.
 *
 * opts:
 *   - email:    string (default 'pending@example.com')
 *   - token:    string (default — свежий generateRandomToken)
 *   - expired:  boolean (default false) — expires_at в прошлом
 *   - used:     boolean (default false)
 *
 * Возвращает { token, user_id, email, expires_at }.
 */
export async function createTestVerifyToken(pool, { user_id, email = 'pending@example.com',
                                                    token = null, expired = false,
                                                    used = false } = {}) {
    const t = token ?? generateRandomToken();
    const expiresAt = expired
        ? new Date(Date.now() - 60 * 1000)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const usedAt = used ? new Date() : null;

    const { rows } = await pool.query(
        `INSERT INTO private_data.email_verify_tokens
           (token, user_id, email, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING token, user_id, email, expires_at`,
        [t, user_id, email, expiresAt, usedAt],
    );
    return {
        token:      rows[0].token,
        user_id:    rows[0].user_id,
        email:      rows[0].email,
        expires_at: rows[0].expires_at,
    };
}

/**
 * Создаёт magic-link токен в БД для тестов /auth/login-magic.
 *
 * opts:
 *   - token:    string (default — свежий generateRandomToken)
 *   - expired:  boolean (default false)
 *   - used:     boolean (default false)
 *   - ip:       string | null (default null)
 *
 * Возвращает { token, user_id, expires_at }.
 */
export async function createTestMagicLinkToken(pool, { user_id, token = null,
                                                       expired = false, used = false,
                                                       ip = null } = {}) {
    const t = token ?? generateRandomToken();
    const expiresAt = expired
        ? new Date(Date.now() - 60 * 1000)
        : new Date(Date.now() + 30 * 60 * 1000);
    const usedAt = used ? new Date() : null;

    const { rows } = await pool.query(
        `INSERT INTO private_data.magic_link_tokens
           (token, user_id, expires_at, used_at, ip_address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING token, user_id, expires_at`,
        [t, user_id, expiresAt, usedAt, ip],
    );
    return { token: rows[0].token, user_id: rows[0].user_id, expires_at: rows[0].expires_at };
}

/**
 * Создаёт активный OTP-код в БД для тестов /auth/verify.
 *
 * Перед вызовом требуется setTestAuthSecrets() — hashOtpCode читает
 * OTP_HMAC_SECRET из env.
 *
 * opts:
 *   - code:           string (default '1234' для flash_call)
 *   - channel:        'flash_call' | 'voice' | 'sms' (default 'flash_call')
 *   - expired:        boolean (default false) — expires_at в прошлом
 *   - used:           boolean (default false) — пометить used_at = now()
 *   - attempts:       number (default 0)
 *   - ip:             string | null (default null)
 *
 * Возвращает { id, code, code_hash, expires_at }.
 */
export async function createTestOtp(pool, { phone, code = '1234', channel = 'flash_call',
                                            expired = false, used = false,
                                            attempts = 0, ip = null } = {}) {
    const codeHash = hashOtpCode(code);
    const expiresAt = expired
        ? new Date(Date.now() - 60 * 1000)
        : new Date(Date.now() + 5 * 60 * 1000);
    const usedAt = used ? new Date() : null;

    const { rows } = await pool.query(
        `INSERT INTO private_data.otp_codes
           (phone, code_hash, channel, expires_at, used_at, attempts_count, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, code_hash, expires_at`,
        [phone, codeHash, channel, expiresAt, usedAt, attempts, ip],
    );
    return { id: rows[0].id, code, code_hash: rows[0].code_hash, expires_at: rows[0].expires_at };
}
