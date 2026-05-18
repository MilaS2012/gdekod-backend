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
export const TEST_JWT_SECRET = 'test-jwt-secret-min-32-bytes-AAAAAAAA';

export function setTestJwtSecret() {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}
export function resetTestJwtSecret() {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}
