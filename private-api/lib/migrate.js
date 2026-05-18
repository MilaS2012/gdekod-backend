// =============================================================================
// migrate.js — чтение и применение SQL-миграций.
//
// Используется:
//   - в тестах через pg-mem (test/migrations.test.js)
//   - в проде через отдельный CLI-скрипт (добавим в 6.10 в составе CI/CD)
//
// Минимализм: ни таблицы schema_migrations, ни tracking — каждая миграция
// идемпотентна (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), поэтому её
// можно прогонять заново сколько угодно раз. В будущем добавим tracking.
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const ROLLBACK_DIR   = path.join(MIGRATIONS_DIR, 'rollback');

const MIGRATION_PATTERN = /^\d{3}_.*\.sql$/;
const ROLLBACK_PATTERN  = /^\d{3}_rollback\.sql$/;

/**
 * Список миграций в порядке применения (по числовому префиксу).
 */
export async function listMigrations() {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files.filter(f => MIGRATION_PATTERN.test(f)).sort();
}

/**
 * Список rollback-файлов в порядке отката (от последнего к первому).
 */
export async function listRollbacks() {
    const files = await fs.readdir(ROLLBACK_DIR);
    return files.filter(f => ROLLBACK_PATTERN.test(f)).sort().reverse();
}

export async function readMigration(name) {
    return fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
}

export async function readRollback(name) {
    return fs.readFile(path.join(ROLLBACK_DIR, name), 'utf8');
}

/**
 * Применяет все миграции по порядку. Каждая — отдельный query.
 * client — объект с .query(sql) → Promise (pg.Client, pg.Pool или pg-mem-клиент).
 */
export async function applyAll(client) {
    const files = await listMigrations();
    for (const f of files) {
        const sql = await readMigration(f);
        await client.query(sql);
    }
    return files;
}

/**
 * Откатывает все миграции (от старшей к младшей).
 */
export async function rollbackAll(client) {
    const files = await listRollbacks();
    for (const f of files) {
        const sql = await readRollback(f);
        await client.query(sql);
    }
    return files;
}
