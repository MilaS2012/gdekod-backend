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
