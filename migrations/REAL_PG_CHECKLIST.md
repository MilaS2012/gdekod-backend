# Чек-лист тестов на реальном Postgres (этап 6.10)

Эти проверки **нельзя** выполнить в `pg-mem` 3.x из-за известных ограничений (см. шапку [`private-api/test/migrations.test.js`](../private-api/test/migrations.test.js)). После того как мы получим доступ к Yandex Managed PostgreSQL, прогоняем их живьём — на dev-инстанции или в Docker с настоящим Postgres.

Этот файл потом перенесём в задачи этапа 6.10.

## Что проверить

- [ ] **Триггер `trg_users_updated_at` реально обновляет `users.updated_at`** при `UPDATE` любого поля. Вставляем user, читаем `updated_at`, `UPDATE ... SET phone = '...'`, читаем `updated_at` снова — должен измениться.
- [ ] **`CREATE EXTENSION pgcrypto` работает в Yandex Managed PostgreSQL.** Если внезапно нет — переключаемся на `lib/id.js newId()` для генерации UUID в Node, убираем `DEFAULT gen_random_uuid()` из DDL отдельной миграцией.
- [ ] **Round-trip миграций без артефактов:** `apply 001-006 → apply rollback 006-001 → apply 001-006 снова`. Не должно быть ошибок типа «relation X already exists» (это pg-mem-баг с PK-индексами при `DROP TABLE CASCADE`).
- [ ] **Повторный `CREATE TABLE IF NOT EXISTS` — реально no-op.** Применяем миграцию 001, INSERT данных, применяем 001 повторно, читаем данные — должны быть на месте без ошибок (без обходов через try/catch).
- [ ] **`DROP FUNCTION private_data.set_updated_at();` (с пустыми скобками)** — корректно выполняется в rollback 001. pg-mem на этом синтаксисе падает.
- [ ] **`DO $$ ... END $$` с `RAISE NOTICE` в rollback 001** — реально пишет предупреждение в psql output («⚠️  rollback 001 удалит все таблицы …»).
- [ ] **Производительность `idx_sessions_active` (partial WHERE revoked_at IS NULL)** при ≥ 100k строк в `auth_sessions`. `EXPLAIN ANALYZE SELECT ... WHERE session_id=$1 AND revoked_at IS NULL` должен использовать partial-индекс, не sequential scan.
- [ ] **UNIQUE violation возвращает SQLSTATE `23505` в `err.code`** (для `handlers/auth/email/attach.js` race-catch при INSERT). pg-mem может не имитировать конкретный SQLSTATE. В реальном PG: создаём 2 параллельных attach с одним email на разных user'ах → один проходит, второй ловит ошибку с `err.code === '23505'` и возвращает 409 email_taken (не 500).
- [ ] **Partial unique `idx_otp_one_active_per_phone` (`WHERE used_at IS NULL`) не ломает SELECT по phone.** В pg-mem 3.x обнаружен bug: после создания такого индекса `SELECT * FROM otp_codes WHERE phone = $1` возвращает 0 строк, если у строки `used_at IS NOT NULL`. Планировщик ошибочно применяет index-WHERE ко всему. Проверяем, что реальный PG ведёт себя корректно: вставляем 5 used OTP с одним phone (partial unique это разрешает), `SELECT WHERE phone=$1` должен вернуть все 5 строк. См. test/helpers.js — там этот индекс дропается для обхода pg-mem-бага.
- [ ] **Partial unique `idx_subs_one_active_per_user` (`WHERE status='active'`) не ломает SELECT по user_id.** Тот же баг pg-mem что и с otp_codes: после создания индекса `SELECT * FROM subscriptions WHERE user_id=$1` без явного фильтра по status возвращает 0 rows для pending/cancelled/expired подписок. На реальном PG проверяем: вставляем подписку с status='cancelled' для user_X, потом `SELECT * FROM subscriptions WHERE user_id=$1` должен вернуть её. В test/helpers.js этот индекс дропается для обхода.
- [ ] **Partial regular индексы `idx_coupons_status_checked`, `idx_coupons_tier_lastcheck`, `idx_coupons_urgent` (все WHERE status='active') не ломают SELECT по другим условиям.** В pg-mem 3.x обнаружено: после создания этих partial-индексов, SELECT по `public_data.coupons` иногда возвращает неполные результаты при `WHERE last_checked_at < $cutoff` (например, фильтрует и status, и условия партиала). В test/helpers.js эти индексы дропаются. На реальном PG проверяем: создаём 3+ active coupons с разными `last_checked_at`, делаем `SELECT WHERE tier=N AND last_checked_at < cutoff` — должны вернуться все подходящие, не только NULL.
- [ ] **TIMESTAMPTZ comparison через Date params в pg-pool-adapter.** Обнаружено: в pg-mem 3.x при INSERT TIMESTAMPTZ через `now() - interval` (или JS Date object), последующий SELECT с `WHERE col < $param` иногда не находит правильные строки даже при `$param::timestamptz` cast. ISO-string в обе стороны работает корректно. В handler'ах (`coupons-list.js`, `urgent-queue.js`) и тестовых фабриках используется `.toISOString()` для всех cutoff. На реальном PG этого quirk нет — TIMESTAMPTZ comparison работает с любым форматом параметра.

## Сопутствующие проверки (на той же сессии)

Полезно прогнать заодно, раз уж есть живая БД:

- [ ] **`gen_random_uuid()` действительно случайна** — генерируем 1000 UUID, у всех 32 hex-символа без дубликатов.
- [ ] **`UNIQUE` на `users.phone`** реально работает с конкурентными INSERT'ами (два параллельных коннекта, один проходит, второй получает unique violation).
- [ ] **`ON DELETE CASCADE`** — `DELETE FROM users WHERE id=...` каскадно сносит записи в `email_verify_tokens`, `magic_link_tokens`, `auth_sessions`. В pg-mem проверено, но на проде хочется убедиться, что в YC Managed нет неожиданных ограничений.
- [ ] **`INET` тип** принимает IPv6 (`::1`, `2001:db8::1`) — pg-mem мы проверяли только на IPv4.

## Что делаем при провале каждого пункта

| Пункт | План B при провале |
|---|---|
| Триггер `set_updated_at` | Перенос логики в код приложения (явное `updated_at = now()` в UPDATE-запросах). |
| `pgcrypto` недоступен | Убираем `DEFAULT gen_random_uuid()` из DDL миграцией 007, всегда передаём id из `lib/id.js newId()`. |
| Round-trip ломается | Чинит миграцию (например, не использовать `CASCADE` — DROP в правильном порядке). |
| `CREATE TABLE IF NOT EXISTS` не no-op | Перепишем все миграции через `BEGIN ... DO $$ IF NOT EXISTS ... END $$ ... COMMIT`. |
| `DROP FUNCTION x()` ломается | Заменим на `DROP FUNCTION x` без скобок (специфика старых версий PG). |
| `DO ... RAISE NOTICE` | Заменим на `\echo` (psql meta-команда) — но потеряем переносимость на другие клиенты. |
| Partial-индекс не используется | `EXPLAIN ANALYZE`, проверяем `pg_stat_user_indexes` после `VACUUM ANALYZE`. Если планировщик упорствует — `SET enable_seqscan = off` для проверки, и пересматриваем форму запроса. |
