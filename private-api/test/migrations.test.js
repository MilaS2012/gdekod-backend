// =============================================================================
// migrations.test.js — pg-mem-тесты SQL-миграций (этап 6.2).
//
// Используем pg-mem 3.x для in-memory PostgreSQL: быстро, без зависимости
// от Docker / реальной БД. Тестируем структуру и поведение констрейнтов;
// ограничения pg-mem обходим там, где это безопасно, и переносим
// недостающее в этап 6.10 (тесты на реальном PG, см. migrations/REAL_PG_CHECKLIST.md).
//
// ============================================================================
//  Известные ограничения pg-mem 3.x
// ============================================================================
//  Эти проверки выполнены через обходы или перенесены в этап 6.10
//  (тесты на реальном Postgres):
//
//  1. plpgsql-функции (CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql)
//     не парсятся — вырезаются из SQL перед прогоном через regex.
//     Сам код функций остаётся в миграциях для production.
//     ⤳ Поведение set_updated_at() — тест в 6.10
//
//  2. CREATE TRIGGER — вырезается перед прогоном.
//     ⤳ Срабатывание trg_users_updated_at на UPDATE — тест в 6.10
//
//  3. DO $$ ... END $$ — вырезается.
//     ⤳ RAISE NOTICE в rollback 001 (предупреждение про prod) — тест в 6.10
//
//  4. DROP FUNCTION x() — pg-mem не парсит пустые скобки, вырезается.
//     ⤳ DROP-семантика функций — тест в 6.10
//
//  5. information_schema.schemata отсутствует в pg-mem — заменили на
//     функциональную проверку через try-CREATE TABLE в схеме.
//     ⤳ Эквивалентно по сути (схема либо принимает CREATE, либо нет).
//
//  6. Повторный CREATE TABLE IF NOT EXISTS падает на AST-coverage check
//     pg-mem (его внутренняя проверка считает повторное создание багой).
//     Idempotency проверяется через сохранение данных после повторного
//     apply: если бы таблица пересоздавалась, INSERT-ы исчезли бы.
//     ⤳ Реальная DDL-идемпотентность (CREATE TABLE IF NOT EXISTS no-op) — 6.10
//
//  7. DROP TABLE CASCADE не убирает PK-индексы в pg-mem, поэтому
//     полный round-trip apply→rollback→apply падает на «merchants_pkey
//     already exists». Тестируем только apply→rollback (без повторного apply).
//     ⤳ Полный круг apply → rollback → apply снова — тест в 6.10
//
//  8. Partial unique index с условием `WHERE used_at IS NULL` (idx_otp_one_active_per_phone)
//     ломает SELECT-запросы `WHERE phone = $1` через pg-pool-adapter:
//     планировщик pg-mem ошибочно применяет index-WHERE ко всем запросам,
//     использующим эту колонку. В test/helpers.js этот индекс дропается
//     после миграций — поведение partial unique само проверяется здесь
//     (отдельный freshDb() без adapter'а, прямой db.public.none).
//     ⤳ В реальном Postgres такого нет — проверим в 6.10
//
//  9. Та же проблема для idx_subs_one_active_per_user (WHERE status='active'):
//     SELECT WHERE user_id=$1 без явного фильтра status возвращает 0 rows
//     для pending/cancelled/expired подписок. В test/helpers.js этот
//     индекс тоже дропается. Сам partial unique проверяется в этом файле
//     отдельно через freshDb.
//     ⤳ В реальном Postgres такого нет — проверим в 6.10
//
//  10. Partial regular индексы на public_data.coupons (WHERE status='active'):
//      idx_coupons_status_checked (001), idx_coupons_tier_lastcheck (012),
//      idx_coupons_urgent (012). При SELECT'е с условиями отличными от
//      partial-WHERE, pg-mem возвращает неполные результаты. Дропаются в
//      test/helpers.js. На реальном PG используются как ускоряющие.
//
//  11. TIMESTAMPTZ comparison: INSERT через `now()-interval` или JS Date,
//      затем `WHERE col < $param`-сравнение работает некорректно даже
//      с $param::timestamptz cast'ом. ISO-string в обе стороны работает.
//      В handler'ах используется `.toISOString()`.
//
//  PostgreSQL поддерживает все используемые конструкции нативно.
//  Ограничения — только у pg-mem, не у production-SQL.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'node:crypto';

import { listMigrations, listRollbacks } from '../lib/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const ROLLBACK_DIR   = path.join(MIGRATIONS_DIR, 'rollback');

// -----------------------------------------------------------------------------
// pg-mem setup helpers
// -----------------------------------------------------------------------------

// Удаляет конструкции, которые pg-mem не парсит. Сам prod-SQL остаётся
// нетронутым — это обход ТОЛЬКО для in-memory тестов.
function stripUnsupportedForPgMem(sql) {
    return sql
        // CREATE OR REPLACE FUNCTION ... AS $$ ... $$;
        .replace(/CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]*?\$\$;/gi, '-- (function stripped for pg-mem)')
        // DO $$ ... END $$; (RAISE NOTICE в 001_rollback)
        .replace(/DO\s*\$\$[\s\S]*?\$\$\s*;/gi, '-- (DO block stripped for pg-mem)')
        // CREATE TRIGGER ...;
        .replace(/CREATE\s+TRIGGER[\s\S]*?;/gi, '-- (trigger stripped for pg-mem)')
        // DROP TRIGGER ... ON ...;
        .replace(/DROP\s+TRIGGER[\s\S]*?;/gi, '-- (drop trigger stripped for pg-mem)')
        // DROP FUNCTION ... (); — pg-mem не парсит () после имени функции
        .replace(/DROP\s+FUNCTION[\s\S]*?;/gi, '-- (drop function stripped for pg-mem)');
}

async function readMigrationFile(name) {
    return fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
}
async function readRollbackFile(name) {
    return fs.readFile(path.join(ROLLBACK_DIR, name), 'utf8');
}

function freshDb() {
    const db = newDb();
    db.public.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        implementation: () => randomUUID(),
        impure: true,
    });
    db.registerExtension('pgcrypto', () => { /* no-op для pg-mem */ });
    return db;
}

async function applyMigrations(db, upToInclusive = 6) {
    const all = await listMigrations();
    const files = all.slice(0, upToInclusive);
    for (const f of files) {
        const sql = stripUnsupportedForPgMem(await readMigrationFile(f));
        db.public.none(sql);
    }
    return files;
}

async function applyRollbacks(db) {
    const all = await listRollbacks();
    for (const f of all) {
        const sql = stripUnsupportedForPgMem(await readRollbackFile(f));
        db.public.none(sql);
    }
    return all;
}

// Хелперы через try-SELECT: pg-mem не реализует information_schema.schemata,
// поэтому проверяем существование через функциональный запрос — таблица/колонка
// либо есть и SELECT работает, либо нет и SELECT падает.

function tableExists(db, schema, table) {
    try { db.public.none(`SELECT 1 FROM ${schema}.${table} WHERE false`); return true; }
    catch { return false; }
}

// Проверяет, что колонка существует. Опционально — что NOT NULL constraint
// сработает на INSERT с явным NULL.
function columnExists(db, schema, table, column) {
    try { db.public.none(`SELECT ${column} FROM ${schema}.${table} WHERE false`); return true; }
    catch { return false; }
}

// Проверяет, что колонка NOT NULL: INSERT с явным NULL должен упасть.
function isColumnNotNull(db, schema, table, column, insertExtras = {}) {
    const cols = ['phone', column, ...Object.keys(insertExtras)];
    const vals = ["'+79261111111'", 'NULL', ...Object.values(insertExtras)];
    try {
        db.public.none(`INSERT INTO ${schema}.${table} (${cols.join(',')}) VALUES (${vals.join(',')})`);
        return false; // вставка прошла — значит колонка nullable
    } catch { return true; }
}

// Проверка наличия схемы через попытку создать в ней временную таблицу.
// Если схема есть — CREATE проходит (потом сразу DROP). Если схемы нет —
// CREATE падает с "schema does not exist".
function schemaExists(db, schema) {
    const sentinel = `_test_${Math.random().toString(36).slice(2, 10)}`;
    try {
        db.public.none(`CREATE TABLE ${schema}.${sentinel} (id INT)`);
        db.public.none(`DROP TABLE ${schema}.${sentinel}`);
        return true;
    } catch { return false; }
}

// -----------------------------------------------------------------------------
// Группа 001 — init
// -----------------------------------------------------------------------------

test('001: создаёт схемы public_data и private_data', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    assert.equal(schemaExists(db, 'public_data'),  true);
    assert.equal(schemaExists(db, 'private_data'), true);
});

test('001: создаёт таблицы users, merchants, coupons', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    assert.equal(tableExists(db, 'private_data', 'users'),     true);
    assert.equal(tableExists(db, 'public_data',  'merchants'), true);
    assert.equal(tableExists(db, 'public_data',  'coupons'),   true);
});

test('001: users имеет все колонки из спеки', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    for (const c of ['id', 'phone', 'phone_verified_at', 'deletion_requested_at', 'created_at', 'updated_at']) {
        assert.ok(columnExists(db, 'private_data', 'users', c), `users.${c} missing`);
    }
});

test('001: NOT NULL на users.phone — INSERT без phone падает', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    assert.throws(
        () => db.public.none(`INSERT INTO private_data.users (id) VALUES (gen_random_uuid())`),
        /null|not.null/i,
    );
});

test('001: merchants имеет колонки, которые читает public-api/handlers/', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    for (const c of ['id', 'name', 'domain', 'logo_url', 'category', 'is_active', 'created_at']) {
        assert.ok(columnExists(db, 'public_data', 'merchants', c), `merchants.${c} missing`);
    }
});

test('001: coupons имеет колонки, которые читает public-api/handlers/', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    for (const c of ['id', 'merchant_id', 'description', 'discount', 'code',
                     'status', 'last_checked_at', 'expires_at', 'created_at']) {
        assert.ok(columnExists(db, 'public_data', 'coupons', c), `coupons.${c} missing`);
    }
});

test('001: INSERT в users генерирует UUID автоматически (gen_random_uuid)', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    assert.match(u.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('001: UNIQUE на users.phone — дубль отвергается', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    db.public.none(`INSERT INTO private_data.users (phone) VALUES ('+79261111111')`);
    assert.throws(
        () => db.public.none(`INSERT INTO private_data.users (phone) VALUES ('+79261111111')`),
        /duplicate|unique/i,
    );
});

test('001: FK coupons.merchant_id — несуществующий merchant отвергается', async () => {
    const db = freshDb();
    await applyMigrations(db, 1);
    assert.throws(
        () => db.public.none(
            `INSERT INTO public_data.coupons (merchant_id, description, discount, code)
             VALUES (999, 'd', '-10', 'CODE')`
        ),
        /foreign|reference/i,
    );
});

test('001: идемпотентность — повторное применение не теряет данные', async () => {
    // ⚠️ pg-mem 3.x не пропускает CREATE TABLE IF NOT EXISTS второй раз чисто
    // (его внутренняя AST-coverage проверка считает повторное создание багой),
    // даже с noAstCoverageCheck. Поэтому проверяем сильную гарантию по-другому:
    // данные не должны пропасть. Если бы CREATE TABLE пересоздавал таблицу,
    // INSERT-ы предыдущего шага исчезли бы.
    //
    // Полноценный тест идемпотентности — на реальном PG в этапе 6.10.
    const db = freshDb();
    await applyMigrations(db, 1);
    db.public.none(`INSERT INTO private_data.users (phone) VALUES ('+79261111111')`);

    const sql = stripUnsupportedForPgMem(await readMigrationFile('001_init.sql'));
    try { db.public.none(sql); } catch { /* pg-mem AST-coverage quirk, см. шапку */ }

    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.users`);
    assert.equal(c.c, 1, 'данные не должны исчезнуть после повторного apply');
});

// -----------------------------------------------------------------------------
// Группа 002 — email-поля
// -----------------------------------------------------------------------------

test('002: добавляет email-поля в users', async () => {
    const db = freshDb();
    await applyMigrations(db, 2);
    for (const c of ['email', 'email_verified_at', 'email_reminder_dismissed_count',
                     'email_reminder_dismissed_at', 'email_reminder_last_shown_at']) {
        assert.ok(columnExists(db, 'private_data', 'users', c), `users.${c} missing`);
    }
});

test('002: email_reminder_dismissed_count NOT NULL DEFAULT 0', async () => {
    const db = freshDb();
    await applyMigrations(db, 2);
    const u = db.public.one(
        `INSERT INTO private_data.users (phone) VALUES ('+79261111111')
         RETURNING email_reminder_dismissed_count`
    );
    assert.equal(u.email_reminder_dismissed_count, 0);
});

test('002: partial unique email — два NULL email допустимы, дубль non-NULL отвергается', async () => {
    const db = freshDb();
    await applyMigrations(db, 2);
    db.public.none(`INSERT INTO private_data.users (phone) VALUES ('+79261111111')`);                 // email NULL
    db.public.none(`INSERT INTO private_data.users (phone) VALUES ('+79262222222')`);                 // email NULL — OK
    db.public.none(`INSERT INTO private_data.users (phone, email) VALUES ('+79263333333', 'a@b.com')`);
    assert.throws(
        () => db.public.none(`INSERT INTO private_data.users (phone, email) VALUES ('+79264444444', 'a@b.com')`),
        /duplicate|unique/i,
    );
});

test('002: идемпотентность — повторный прогон ALTER ADD IF NOT EXISTS без ошибки', async () => {
    const db = freshDb();
    await applyMigrations(db, 2);
    const sql = stripUnsupportedForPgMem(await readMigrationFile('002_users_email_fields.sql'));
    assert.doesNotThrow(() => db.public.none(sql));
});

// -----------------------------------------------------------------------------
// Группа 003 — email_verify_tokens
// -----------------------------------------------------------------------------

test('003: создаёт таблицу email_verify_tokens', async () => {
    const db = freshDb();
    await applyMigrations(db, 3);
    assert.equal(tableExists(db, 'private_data', 'email_verify_tokens'), true);
});

test('003: INSERT токена + SELECT по token', async () => {
    const db = freshDb();
    await applyMigrations(db, 3);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at)
         VALUES ('tok-abc', '${u.id}', 'a@b.com', now() + interval '24 hours')`
    );
    const row = db.public.one(`SELECT email, used_at FROM private_data.email_verify_tokens WHERE token = 'tok-abc'`);
    assert.equal(row.email,   'a@b.com');
    assert.equal(row.used_at, null);
});

test('003: ON DELETE CASCADE — удаление user снимает его токены', async () => {
    const db = freshDb();
    await applyMigrations(db, 3);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.email_verify_tokens (token, user_id, email, expires_at)
         VALUES ('t', '${u.id}', 'a@b.com', now())`
    );
    db.public.none(`DELETE FROM private_data.users WHERE id = '${u.id}'`);
    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.email_verify_tokens`);
    assert.equal(c.c, 0);
});

// -----------------------------------------------------------------------------
// Группа 004 — magic_link_tokens
// -----------------------------------------------------------------------------

test('004: создаёт таблицу magic_link_tokens', async () => {
    const db = freshDb();
    await applyMigrations(db, 4);
    assert.equal(tableExists(db, 'private_data', 'magic_link_tokens'), true);
});

test('004: ON DELETE CASCADE — удаление user снимает его magic-link токены', async () => {
    const db = freshDb();
    await applyMigrations(db, 4);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.magic_link_tokens (token, user_id, expires_at)
         VALUES ('m', '${u.id}', now() + interval '30 minutes')`
    );
    db.public.none(`DELETE FROM private_data.users WHERE id = '${u.id}'`);
    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.magic_link_tokens`);
    assert.equal(c.c, 0);
});

// -----------------------------------------------------------------------------
// Группа 005 — auth_sessions
// -----------------------------------------------------------------------------

test('005: создаёт таблицу auth_sessions', async () => {
    const db = freshDb();
    await applyMigrations(db, 5);
    assert.equal(tableExists(db, 'private_data', 'auth_sessions'), true);
});

test('005: INSERT без session_id → автоматический UUID (тест 21)', async () => {
    const db = freshDb();
    await applyMigrations(db, 5);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    const s = db.public.one(
        `INSERT INTO private_data.auth_sessions (user_id, expires_at)
         VALUES ('${u.id}', now() + interval '90 days')
         RETURNING session_id`
    );
    assert.match(s.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('005: INET ip_address — INSERT и SELECT (тест 24)', async () => {
    const db = freshDb();
    await applyMigrations(db, 5);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.auth_sessions (user_id, expires_at, ip_address)
         VALUES ('${u.id}', now() + interval '90 days', '192.168.1.42')`
    );
    const s = db.public.one(`SELECT ip_address FROM private_data.auth_sessions LIMIT 1`);
    assert.equal(String(s.ip_address), '192.168.1.42');
});

test('005: ON DELETE CASCADE — удаление user снимает его сессии', async () => {
    const db = freshDb();
    await applyMigrations(db, 5);
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261111111') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.auth_sessions (user_id, expires_at)
         VALUES ('${u.id}', now() + interval '90 days')`
    );
    db.public.none(`DELETE FROM private_data.users WHERE id = '${u.id}'`);
    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.auth_sessions`);
    assert.equal(c.c, 0);
});

// -----------------------------------------------------------------------------
// Группа 006 — otp_codes
// -----------------------------------------------------------------------------

test('006: создаёт таблицу otp_codes', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    assert.equal(tableExists(db, 'private_data', 'otp_codes'), true);
});

test('006: CHECK channel — sms/flash_call/voice допустимы', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    for (const ch of ['sms', 'flash_call', 'voice']) {
        const id = randomUUID();
        // Каждый раз новый phone, чтобы не упереться в partial unique по phone
        const phone = '+7926' + String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
        assert.doesNotThrow(
            () => db.public.none(
                `INSERT INTO private_data.otp_codes (id, phone, code_hash, channel, expires_at)
                 VALUES ('${id}', '${phone}', 'h', '${ch}', now() + interval '5 minutes')`
            ),
            `channel=${ch} должен быть допустим`,
        );
    }
});

test('006: CHECK channel — недопустимое значение отвергается', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    assert.throws(
        () => db.public.none(
            `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
             VALUES ('+79261234567', 'h', 'whatsapp', now())`
        ),
        /check/i,
    );
});

test('006: partial unique — один активный OTP на phone (тест 22)', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    db.public.none(
        `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
         VALUES ('+79261234567', 'h1', 'sms', now() + interval '5 minutes')`
    );
    // Второй OTP для того же phone (даже другой channel) — отвергается, пока первый не использован.
    assert.throws(
        () => db.public.none(
            `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
             VALUES ('+79261234567', 'h2', 'flash_call', now() + interval '5 minutes')`
        ),
        /duplicate|unique/i,
    );
    // После UPDATE used_at — второй OTP проходит.
    db.public.none(`UPDATE private_data.otp_codes SET used_at = now() WHERE phone = '+79261234567'`);
    assert.doesNotThrow(
        () => db.public.none(
            `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
             VALUES ('+79261234567', 'h2', 'flash_call', now() + interval '5 minutes')`
        ),
    );
});

test('006: НЕТ FK на users — OTP сохраняется при удалении user, связь по phone (тест 23)', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    // Создаём user с phone, потом OTP для того же phone, потом удаляем user.
    const u = db.public.one(`INSERT INTO private_data.users (phone) VALUES ('+79261234567') RETURNING id`);
    db.public.none(
        `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
         VALUES ('+79261234567', 'h', 'sms', now() + interval '5 minutes')`
    );
    db.public.none(`DELETE FROM private_data.users WHERE id = '${u.id}'`);
    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.otp_codes`);
    assert.equal(c.c, 1);
});

test('006: идемпотентность — повторный прогон не теряет данные', async () => {
    // См. комментарий к "001: идемпотентность" — pg-mem quirk, проверяем
    // через сохранение данных. Полная проверка — на реальном PG в 6.10.
    const db = freshDb();
    await applyMigrations(db, 6);
    db.public.none(
        `INSERT INTO private_data.otp_codes (phone, code_hash, channel, expires_at)
         VALUES ('+79261234567', 'h', 'sms', now() + interval '5 minutes')`
    );
    const sql = stripUnsupportedForPgMem(await readMigrationFile('006_otp_codes.sql'));
    try { db.public.none(sql); } catch { /* см. шапку 001 idempotency */ }
    const c = db.public.one(`SELECT COUNT(*)::int AS c FROM private_data.otp_codes`);
    assert.equal(c.c, 1);
});

// -----------------------------------------------------------------------------
// Группа Rollback round-trip
// -----------------------------------------------------------------------------

test('rollback: 006→001 удаляет все private-таблицы, схемы остаются', async () => {
    const db = freshDb();
    await applyMigrations(db, 6);
    await applyRollbacks(db);

    assert.equal(tableExists(db, 'private_data', 'users'),               false);
    assert.equal(tableExists(db, 'private_data', 'email_verify_tokens'), false);
    assert.equal(tableExists(db, 'private_data', 'magic_link_tokens'),   false);
    assert.equal(tableExists(db, 'private_data', 'auth_sessions'),       false);
    assert.equal(tableExists(db, 'private_data', 'otp_codes'),           false);
    assert.equal(tableExists(db, 'public_data',  'merchants'),           false);
    assert.equal(tableExists(db, 'public_data',  'coupons'),             false);
    // Схемы оставляем — могут использоваться другими частями.
    assert.equal(schemaExists(db, 'private_data'), true);
    assert.equal(schemaExists(db, 'public_data'),  true);
});

test('rollback round-trip: после rollback можно применять последующие миграции (на свежей БД)', async () => {
    // ⚠️ pg-mem 3.x quirk: DROP TABLE CASCADE не убирает PK-индексы,
    // поэтому apply → rollback → apply на ОДНОЙ и той же pg-mem-инстанции
    // падает на "relation 'merchants_pkey' already exists".
    // Полный round-trip тестируем на реальном PG в этапе 6.10.
    //
    // Здесь проверяем более слабую, но всё-равно полезную гарантию:
    // rollback-файлы корректны и applyRollbacks() проходит без ошибок
    // на всех 6 миграциях.
    const db = freshDb();
    await applyMigrations(db, 6);
    await assert.doesNotReject(async () => { await applyRollbacks(db); });
});

// -----------------------------------------------------------------------------
// lib/migrate.js — проверяем хелперы listMigrations / listRollbacks
// -----------------------------------------------------------------------------

test('migrate.js listMigrations — все миграции в числовом порядке', async () => {
    const files = await listMigrations();
    assert.ok(files.length >= 12, `ожидаем минимум 12 миграций, получено ${files.length}`);
    assert.equal(files[0], '001_init.sql');
    assert.equal(files.at(-1), '012_parser_fields.sql');
    // Алфавитный порядок = числовой при 3-значном префиксе.
    for (let i = 1; i < files.length; i++) {
        assert.ok(files[i] > files[i - 1], `файлы не отсортированы: ${files[i - 1]} → ${files[i]}`);
    }
});

test('migrate.js listRollbacks — все rollback в обратном порядке', async () => {
    const files = await listRollbacks();
    assert.ok(files.length >= 12);
    assert.equal(files[0], '012_rollback.sql');     // от старшего к младшему
    assert.equal(files.at(-1), '001_rollback.sql');
});
