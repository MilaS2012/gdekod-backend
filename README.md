# gdekod-backend

Backend для сервиса **ГдеКод** (`gde-code.ru`) — каталог промокодов российских интернет-магазинов. Целевая инфраструктура — **Yandex Cloud** (Cloud Functions + Managed PostgreSQL + Object Storage + Container Registry).

Репозиторий — **монорепо** из нескольких независимо деплоящихся под-пакетов: каждый со своим `package.json`, своими зависимостями, своим CI-флоу.

> **ТЗ:** см. [`docs/ТЗ_ГдеКод_MVP_v15_FINAL.docx`](docs/ТЗ_ГдеКод_MVP_v15_FINAL.docx)
> **Тестирование:** см. [`docs/Стратегия_тестирования_ГдеКод_v1.docx`](docs/Стратегия_тестирования_ГдеКод_v1.docx)
>
> С этого момента все этапы — по правилам Стратегии тестирования. **Без тестов код в `main` не уходит.**

## Структура

```
.
├── README.md                ← этот файл
├── package.json             ← мета-пакет: прокси-скрипты к под-пакетам
│
├── public-api/              ← Этап 5: публичный read-only API
│   ├── handlers/            ← merchants-list, merchant-detail,
│   │                          coupons-list, coupon-detail, health
│   ├── lib/                 ← db (pg pool), cors, mask-code, response
│   ├── test/                ← node:test, моки PG
│   └── README.md            ← endpoints, JSON-примеры, принципы
│
├── parser/                  ← Этап 8: Playwright-парсер с tiered scheduling
│   ├── checker.js           ← проверка одного промокода
│   ├── scheduler.js         ← раскладка проверок по уровням свежести
│   ├── queue.js             ← очередь задач
│   ├── reporter.js          ← запись результатов в БД
│   ├── merchants/           ← селекторы под конкретные магазины
│   ├── timer-trigger/       ← entrypoint для Yandex Cloud Functions
│   ├── test/                ← одиночная проверка для отладки
│   ├── Dockerfile           ← для Container Registry / Cloud Run-аналога
│   └── README.md
│
└── src/handlers/private/    ← Этап 6: приватный API (план, README.md)
                                После реализации сюда переедут
                                auth/, subscription/, account/, support/.
```

> Схемы PostgreSQL пока живут в `gdekod-frontend/database/postgresql/` (исторически — там был первый deploy-набор скриптов). При следующей итерации перенесём их в этот репо как `database/`, ближе к коду, который их использует.

## Под-пакеты

| Папка | Что делает | Состояние | Тесты |
|---|---|---|---|
| `public-api/` | GET /api/merchants(/{id}), /api/coupons(/{id}), /health | ✓ готово | 21 / 21 (`node:test`) |
| `parser/` | Periodic-проверка промокодов в магазинах через Playwright + Tiered Scheduling | ✓ готово | smoke-test в `test/single-check.js` |
| `private-api/` | Auth + email-привязка + сессии + подписки + аккаунт + промокоды + парсер-эндпоинты + support/events-log + 152-ФЗ export/delete + **CloudPayments webhook'и** (`/auth/*`, `/auth/email/*`, `/auth/banner/dismiss`, `/auth/sessions`, `/auth/logout-all`, `/subscription/*`, `/account/*`, `/coupons/{id}/*`, `/admin/parser/*`, `/support/*`, `/events/*`, `/webhook/cloudpayments/*`), `requireUser` + `requireParserSecret` middleware, rate-limit, mask-pii, billing-config, mock-cron, parser-config, account-cleanup cron, cloudpayments-lib (HMAC timing-safe) | ✅ 6.1–6.11 + 7 готовы | 618 / 618 (`node:test`), coverage 92.05% |

## Скрипты в корне

Корневой `package.json` — мета-обёртка. Реальные команды живут в под-пакетах.

```bash
npm test              # → cd public-api && npm test
npm run test:public-api  # тест публичного API
npm run deploy-public    # → cd public-api && npm run deploy (yc serverless ...)
npm run deploy-private   # пока заглушка
```

Для парсера вызовы — изнутри `parser/`:
```bash
cd parser && npm test
cd parser && npm run start    # локальный прогон scheduler'а
```

### Известные ограничения тестов миграций

Тесты миграций (`private-api/test/migrations.test.js`) используют **pg-mem** (in-memory PostgreSQL), у которого есть ограничения по plpgsql, AST-coverage check и некоторым DROP-операциям. Подробности — в шапке [`private-api/test/migrations.test.js`](private-api/test/migrations.test.js).

Семь моментов тестируются только на реальном Postgres в этапе 6.10 — см. чек-лист в [`migrations/REAL_PG_CHECKLIST.md`](migrations/REAL_PG_CHECKLIST.md). PostgreSQL поддерживает все используемые конструкции нативно — ограничения только у pg-mem, не у production-SQL.

## Этапы по ТЗ v15

Верхнеуровневый трекинг по проекту в целом (не только этот репо).
Этапы 1–3 — историческая нумерация v14 (зафрезен в `docs/ТЗ_v14_ARCHIVED.docx`);
с Этапа 5 нумерация соответствует v15.

| Этап | Что | Где | Статус |
|---|---|---|---|
| 1 | HTML → React + Vite | `gdekod-frontend/` | ✓ |
| 2 | Схема Azure SQL Database | `gdekod-frontend/database/` | ✓ |
| 2.5 | Миграция на PostgreSQL + connection-example + deploy-скрипты на Yandex Object Storage | `gdekod-frontend/database/postgresql/` + `gdekod-frontend/deploy/` + `database/` (TBD) | ✓ |
| 2.6 | Визуал v14 (бейдж свежести, голосование) | `gdekod-frontend/src/` | ✓ |
| 3.1 | Backend-каркас | этот репо | заменён этапами 5+8 |
| 4 | Yandex Cloud setup | — | блокирован верификацией платёжного аккаунта |
| **5** | **Публичный API (read-only)** | `public-api/` | **✅ Завершён 10.05.2026 (21/21 тестов)** |
| **6.1–6.3** | **Приватный API: каркас + миграции + полная auth-инфраструктура** | `private-api/` + `migrations/` | **✅ Завершён 18.05.2026 (221/221 тестов, coverage 94.51%)** |
| **6.4** | **Приватный API: email-привязка (attach + verify + resend) + SMS для регистрации** | `private-api/handlers/auth/email/` | **✅ Завершён 18.05.2026 (267/267 тестов, coverage 93.24%)** |
| **6.5** | **Приватный API: сессии и история (banner/dismiss + sessions + logout-all)** | `private-api/handlers/auth/` + миграция 007 | **✅ Завершён 18.05.2026 (304/304 тестов, coverage 92.95%)** |
| **6.6** | **Приватный API: подписки (operator_mock + CloudPayments-stub, биллинг по тарифу)** | `private-api/handlers/subscription/` + миграции 008-009 | **✅ Завершён 18.05.2026 (353/353 тестов, coverage 93.43%)** |
| **6.7** | **Приватный API: аккаунт и промокоды (profile + history + receipts + reveal/copy/confirm/complaint)** | `private-api/handlers/account/` + `private-api/handlers/coupons/` + миграции 010-011 | **✅ Завершён 18.05.2026 (420/420 тестов, coverage 93.13%)** |
| **6.8** | **Приватный API: парсер-эндпоинты (coupons-list/urgent-queue/coupon-detail/result, X-Parser-Secret timing-safe)** | `private-api/handlers/admin/parser/` + миграция 012 | **✅ Завершён 18.05.2026 (473/473 тестов, coverage 93.26%)** |
| **6.9** | **Приватный API: 152-ФЗ — экспорт данных и удаление аккаунта (export + delete flow + account-cleanup cron)** | `private-api/handlers/account/` + `private-api/lib/account-cleanup.js` + миграция 014 | **✅ Завершён 18.05.2026 (576/576 тестов, coverage 92.92%)** |
| **6.10** | **Приватный API: Финал и подготовка к деплою (cron-обёртки + CI/CD + smoke + .env.template + PRE_DEPLOY_CHECKLIST)** | `private-api/cron/` + `.github/workflows/` + `scripts/` + `docs/` | **✅ Завершён 19.05.2026 (609/609 тестов, coverage ~93%)** |
| **6.11** | **Приватный API: Support tickets + Events log** | `private-api/handlers/support/` + `private-api/handlers/events/` + миграция 013 | **✅ Завершён 18.05.2026** |
| **7** | **CloudPayments интеграция (widget_config + 3 webhook'а pay/recurrent/fail + HMAC-SHA256 timing-safe + idempotency + UNIQUE provider_payment_id)** | `private-api/handlers/webhook/cloudpayments/` + `private-api/lib/cloudpayments.js` + миграция 015 | **✅ Завершён 19.05.2026 (642/642 тестов, coverage ~92%)** |
| **8** | **Парсер промокодов (Playwright + tiered scheduling)** | `parser/` | **✅ Завершён 10.05.2026** |
| 9 | Деплой и подключение домена | `gdekod-frontend/deploy/` | ✅ Завершён 10.05.2026 (внутри 8) |
| 10 | Мониторинг и алерты | — | после стабилизации деплоя |
| 12 | Редирект где-код.рф → gde-code.ru через Cloudflare Page Rule | Cloudflare zone + reg.ru NS | 🟡 Правило стоит, ждём NS-пропагацию |
| **13** | **Стратегия тестирования + регрессия (новое v15)** | `docs/Стратегия_тестирования_ГдеКод_v1.docx` | **✅ Завершён 11.05.2026 · 5–7 ч** |

## Этап 6.3 — итоги

Полная инфраструктура авторизации:
- `POST /api/auth/start` → channel (`sms` для регистрации, `flash_call` для повторного входа без email, `magic_link` при verified email)
- `POST /api/auth/verify` → `200 { jwt }` (сессия 90 дней)
- `POST /api/auth/login-magic` → `200 { jwt }`
- `requireUser` middleware для последующих handler'ов

Покрытие тестами: **94.51%**, **221 тест**.

SMS-провайдер: мок (реальный SMS.ru в 6.10).
Email-провайдер: мок (реальный Yandex Postbox в 6.10).
JWT-секрет: env (Yandex Lockbox в 6.10).

## Этап 6.4 — итоги

Email-привязка для авторизации:
- `POST /api/auth/email/attach` — привязать email
- `POST /api/auth/email/verify` — подтвердить переход
- `POST /api/auth/email/resend` — повторно отправить
- 5 веток состояний (`new` / `replace_unverified` / 409 для смены verified / no-op для same+verified / 409 email_taken)
- Email lowercase + UNIQUE 23505 catch + race protection в `verify` (двойная проверка email)
- Общий `emailAttachRateCheck` для attach + resend (60s cooldown / 5 daily per user)

Также: SMS для первой регистрации (юридическое требование на текстовое согласие подписки 35₽/сутки по требованиям платёжных систем РФ).

Покрытие тестами: **93.24%**, **267 тестов**.

## Этап 6.5 — итоги

Сессии и история устройств:
- `POST /api/auth/banner/dismiss` — отказ от баннера привязки email (3 → hidden permanently)
- `GET  /api/auth/sessions` — список активных устройств с UA-парсингом
- `POST /api/auth/logout-all` — revoke всех сессий user'а (включая текущую)
- `lib/event.js parseUserAgent` — Yandex/Edge/Chrome/Firefox/Safari + macOS/iPhone/Android/Windows/Linux
- Миграция 007 — поле `user_agent_summary` в `auth_sessions`
- JS-сортировка (current first) вместо `ORDER BY CASE` (совместимость pg-mem)

Покрытие тестами: **92.95%** line / **93.67%** funcs, **325 тестов** (21 public + 304 private).

## Этап 6.6 — итоги

Подписки с разделением биллинга по тарифу (ТЗ v16.1 §3.3):
- `GET  /api/subscription/status` — текущая подписка + available_tariffs
- `POST /api/subscription/start` — создать (operator_mock сразу active, cloudpayments → STUB до этапа 7, operator_real → pending до этапа 10)
- `POST /api/subscription/cancel` — отмена, доступ сохраняется до `expires_at`
- Миграции 008-009: `subscriptions` с CHECK constraint `subs_tariff_provider_match` (daily_35↔operator_*, monthly_499↔cloudpayments_*) + `receipts` с `is_mock` маркером
- `lib/billing-config.js` — `TARIFFS`, провайдеры по env, `assertNoMockInProduction` fail-fast
- `lib/mock-cron.js` — эмуляция ежедневных списаний для staging (`FOR UPDATE SKIP LOCKED` в prod)
- `lib/notifications.js` — заглушка `notifyTransactional` с выбором канала email vs SMS

Что НЕ делаем сейчас (TODO):
- Реальный CloudPayments `payment_url` → этап 7
- Webhook'и (`/api/webhook/cloudpayments/*`, `/api/webhook/operator/*`) → этапы 7, 10
- Реальная отправка уведомлений → этап 6.10
- Cron-таймер на Yandex Cloud Functions → этап 6.10

Покрытие тестами: **93.43%** line / **94.32%** funcs, **374 теста** (21 public + 353 private).

## Этап 6.7 — итоги

Аккаунт и взаимодействие с промокодами (ТЗ v16.1 §3.7, §4.2, §19.3, §19.4, §20.4):
- `GET  /api/account/profile` — `phone_masked` даже для самого user (защита от подсматривания экрана)
- `PATCH /api/account/profile` — обновление `display_name` с валидацией (1..50 chars, trim, без ctrl-символов)
- `GET  /api/account/coupons` — история раскрытий с JOIN на public_data, `status='removed'` placeholder для удалённых
- `GET  /api/account/receipts` — чеки с маркером `is_mock` для staging
- `POST /api/coupons/{id}/reveal` — **требует активной подписки** (active или cancelled+expires_at>now); idempotent INSERT через ON CONFLICT
- `POST /api/coupons/{id}/copy` — лог для аналитики (events_log будет в 6.11)
- `POST /api/coupons/{id}/confirm` + `complaint` — 1 голос (любого типа) на (user, coupon) в **24 часа**, общий cooldown через absolute timestamp
- Триггеры жалоб по `complaint_count`:
  - `>= 3` (REPRIORITIZE) — лог `urgent_recheck` для парсера (он сам прочитает в 6.8)
  - `>= 5` (AUTO_EXPIRE) — отдельный race-safe UPDATE `status='expired'`, снимает с витрины
  - `>= 10` (BLOCK_MERCHANT) — WARN-лог, **требует ручного разбора админом** (не блокируем магазин автоматически)
- Миграции 010-011 — `coupon_votes` + `coupon_reveals` + 3 счётчика в `public_data.coupons`; `display_name`/`profile_updated_at` в users

Покрытие тестами: **93.13%** line / **95.10% funcs**, **441 тест** (21 public + 420 private).

## Этап 6.8 — итоги

Парсер-эндпоинты — отдельный контур для воркера, аутентификация через shared secret (ТЗ v16.1 §19.5):
- `GET  /api/admin/parser/coupons` — выдача по уровню свежести (`?tier=1|2|3`); фильтр по `last_checked_at` через absolute ISO-timestamp (раскладка по интервалам `TIER_INTERVALS_HOURS` `{1:3h, 2:8h, 3:24h}`)
- `GET  /api/admin/parser/coupons/urgent` — внеплановая очередь: `complaint_count >= 3 AND status='active'` и `last_checked_at < now - URGENT_RECHECK_INTERVAL_MINUTES (30 мин)`
- `GET  /api/admin/parser/coupons/{id}` — полная карточка купона для парсера (включая `tier`, `last_parse_status`, `last_parse_error`)
- `POST /api/admin/parser/coupons/{id}/result` — приём результата проверки, 5 веток (`active` / `expired` / `invalid` / `not_found` / `parsing_error`); race-safe `expired` через `UPDATE … WHERE status='active'`, второй UPDATE только `last_checked_at` если уже expired — экономия лишних дёрганий; `parsing_error` НЕ меняет `status`; WARN `field_truncated` для слишком длинных `error_text`/`new_code`
- `lib/parser-auth.js requireParserSecret` — `PARSER_SECRET` из env читается на каждый вызов, сравнение через `crypto.timingSafeEqual` с проверкой длины буферов; все ветки ошибок (`no_env_secret` / `no_header` / `invalid_secret`) → единый 401 `invalid_parser_secret` (не разглашаем причину)
- `lib/parser-config.js` — `TIER_INTERVALS_HOURS`, `TIER_LIMITS`, `URGENT_RECHECK_INTERVAL_MINUTES`, `PARSE_RESULT_STATUSES`, `VALID_TIERS`
- Миграция 012 — `tier INT`, `last_successful_check_at`, `last_parse_status`, `last_parse_error` в `public_data.coupons` + partial-индексы `idx_coupons_tier_lastcheck` и `idx_coupons_urgent`
- `.env.example`: `PARSER_SHARED_SECRET` → `PARSER_SECRET` (по спеке 6.8)

pg-mem quirks: partial WHERE на coupons-индексах возвращает неполные результаты через адаптер — индексы дропаются в test/helpers.js, проверка переехала в `migrations/REAL_PG_CHECKLIST.md` (+2 пункта).

Покрытие тестами: **93.26%** line / **95.73% funcs**, **494 теста** (21 public + 473 private). `parser-auth` и `parser-config` — **100%**, handlers 90–96%.

## Этап 6.11 — итоги

Support tickets + Events log (ТЗ v16.1 §19.5, §21.2):
- `GET  /api/support/tickets` — список обращений user'а (spam-тикеты скрыты от user'а, видны только через admin), пагинация через `after_id`
- `POST /api/support/tickets` — создание обращения (5 категорий: `billing`, `access`, `coupon`, `promo`, `other`; subject 1–200 символов, message 10–5000; rate-limit **2/ч, 5/сут** на user; snapshot контактов `phone_masked`/`email_masked` в момент создания)
- `POST /api/events/log` — запись аналитического события (12 whitelisted `event_type`: `coupon_viewed`, `coupon_revealed`, `coupon_copied`, `coupon_confirmed`, `coupon_complained`, `auth_started`, `auth_completed`, `subscription_started`, `subscription_cancelled`, `data_exported`, `deletion_scheduled`, `deletion_cancelled`; JSON payload ≤ 4096 байт; rate-limit 60 событий/мин на user)
- `lib/events-cleanup.js cleanupOldEvents` — удаление событий старше **180 дней** (EVENTS_RETENTION_DAYS, 152-ФЗ)
- Миграция 013 — `support_tickets` (CASCADE) + `events_log` (ON DELETE SET NULL, JSONB payload, INET ip) + 5 индексов
- `lib/support-config.js` — TICKET_CATEGORIES, TICKET_STATUSES, лимиты
- `lib/events-config.js` — EVENT_TYPES, EVENTS_RETENTION_DAYS=180, EVENTS_LIMITS
- `lib/events-rate-limit.js` — in-memory Map rate-limit с `__resetCountersForTest()` для изоляции тестов

Покрытие тестами: **40 тестов** в 4 файлах (A1–A10 tickets-list, B1–B14 tickets-create, C1–C11 events-log, D1–D5 events-cleanup).

## Этап 6.9 — итоги

152-ФЗ: экспорт и удаление аккаунта (ТЗ v16.1 §19.3, §21):
- `POST /api/account/export` — полный экспорт персональных данных (rate-limit 1 раз в 24ч через events_log; 7 параллельных SELECT через Promise.all; unmasked phone/email; заголовок `Content-Disposition: attachment`; INSERT events_log `data_exported`)
- `POST /api/account/delete-request` — запрос OTP-кода для удаления (state-check: already pending → 409, already completed → 410; hourly rate-limit 3 попытки/ч через `account_deletion_otp_codes`; SMS с `purpose='account_deletion'`)
- `POST /api/account/delete-confirm` — подтверждение удаления OTP-кодом (brute-force защита 5 попыток → `too_many_attempts` + погасить OTP; валидный OTP → `deletion_scheduled_at = now + 24h`, revoke всех сессий, cancel активной подписки, INSERT events_log `deletion_scheduled`, notifyTransactional best-effort)
- `POST /api/account/cancel-deletion` — отмена удаления в grace-период (тройной фильтр: `completed` → 410 `already_deleted`; `scheduled < now` → 410 `grace_period_expired`; `scheduled > now` → 200 `restored`, поля NULL, INSERT events_log `deletion_cancelled`)
- `lib/account-cleanup.js processScheduledDeletions` — cron-задача удаления: SELECT кандидатов → атомарный claim (UPDATE `deletion_completed_at = now()` WHERE IS NULL RETURNING) → INSERT events_log `deletion_completed` → DELETE FROM users; try/catch per user (ошибка одного не валит батч); идемпотентность через partial-index (`WHERE scheduled IS NOT NULL AND completed IS NULL`)
- Миграция 014 — `deletion_scheduled_at`, `deletion_completed_at`, `deletion_requested_at` в `users`; отдельная таблица `account_deletion_otp_codes` (не трогает `otp_codes` → zero blast radius на 300+ login-тестов)
- `lib/account-deletion-config.js` — DELETION_GRACE_PERIOD_HOURS=24, OTP_TTL=300s, MAX_ATTEMPTS=5, CLEANUP_BATCH_SIZE=100

pg-mem quirks: partial-index `idx_users_deletion_scheduled` (WHEREclause) ломает query-planner → дропается в `test/helpers.js newPgMemPool()` (quirk #12). TIMESTAMPTZ-сравнение ломается при смешивании JS Date и ISO-строк → все параметры через `.toISOString()` (quirk #11).

**48 тестов** в 5 файлах: A1–A10 export, B1–B8 delete-request, C1–C13 delete-confirm, D1–D8 cancel-deletion (incl. D7 «передумать после revoke»), E1–E9 account-cleanup.

Покрытие тестами: **92.92%** line / **95.74% funcs**, **597 тестов** (21 public + 576 private).

## Этап 6.10 — итоги

Финал и подготовка к деплою (без живого Yandex Cloud — он в верификации):
- **3 cron-обёртки** для Cloud Functions Timer: `cron/mock-daily-charges.js`, `cron/scheduled-deletions.js`, `cron/events-cleanup.js` — тонкие обёртки над lib-функциями, try/catch вокруг всего включая `getPool()`, `_deps.pool` для тестирования
- **Health endpoints patched**: добавлены поля `service: 'private'|'public'` и `version: process.env.GIT_SHA ?? 'dev'` — отображает какая версия задеплоена
- **CI/CD**: `.github/workflows/test.yml` (push/PR → тесты + coverage), `.github/workflows/deploy-staging.yml` (pre-deploy checks + закомментированный `yc` деплой с TODO)
- **Двухуровневая защита** `scripts/check-no-mock-in-prod.sh`: HARD-FAIL на `STUB_TODO`, WARN на runtime-защищённые паттерны — **поймала `payment_url:'STUB_TODO_STAGE_7'` в `subscription/start.js`** → production deploy заблокирован до закрытия этапа 7 (CloudPayments). Именно как должно быть.
- **Smoke-тест** `scripts/smoke-test.sh` — 8 HTTP-запросов после деплоя (merchants, coupons, auth/start, profile, health с Bearer)
- **`.env.production.template`** — 17 ENV-переменных, собранных `grep` из кода, с командами `crypto.randomBytes` для генерации секретов
- **`README_DEPLOY.md`** — 10-раздельная инструкция: секреты → Lockbox → миграции → Cloud Functions (таблица 21 функции с entrypoint и trigger-типом) → smoke → мониторинг → откат
- **`docs/PRE_DEPLOY_CHECKLIST.md`** — 37 пунктов перед production: Yandex Cloud, БД, Lockbox, SMS.ru, Postbox, CloudPayments, CDN/SPA/DNS фронтенда, assertNoMockInProduction тест в изоляции

**11 новых тестов** в 3 файлах: F1–F6 cron-handlers, G1–G3 private health, G4–G6 public health.

Покрытие тестами: **~93%** line / **~95%** funcs, **609 тестов** (24 public + 585 private).

## Этап 7 — итоги

CloudPayments интеграция (ТЗ v16.1 §3.3.1):
- **Замена STUB_TODO_STAGE_7** в `handlers/subscription/start.js`: `payment_url: 'STUB_TODO_STAGE_7'` → полноценный `widget_config: { publicId, amount (в рублях), currency, description, accountId, invoiceId, skin: 'modern' }`. Без `CLOUDPAYMENTS_PUBLIC_ID` в env → **fail-loud 500** (паттерн как у JWT_SECRET, не silent broken widget). `check-no-mock-in-prod.sh` теперь проходит без HARD-FAIL — production deploy разблокирован.
- **`lib/cloudpayments.js`** — 3 функции: `verifyWebhookHmac(rawBody, hmac)` через HMAC-SHA256 + `crypto.timingSafeEqual` (нет secret → **throws**, а не silent false; разные длины → false ДО `timingSafeEqual` чтобы не было RangeError или timing-leak на длину); `mapCpStatus` (4 known + unknown); `kopecksToRubles`
- **Миграция 015** — `subscriptions.last_charge_at`, `receipts.is_failed`, partial-индекс `idx_receipts_failed`, **UNIQUE `idx_receipts_payment_id (provider, provider_payment_id) WHERE NOT NULL`** — belt-and-suspenders race-защита от дубликатов receipt при ретраях webhook'а (~10мс race-окно между SELECT и INSERT)
- **3 webhook-эндпоинта** (`/api/webhook/cloudpayments/{pay,recurrent,fail}`):
  - **`/pay`**: HMAC → idempotency-SELECT по `provider_payment_id` → SELECT sub → race-safe `UPDATE WHERE status='pending'` → INSERT receipt (is_failed=false) → events_log → `notifyTransactional kind='subscription_activated'` (best-effort try/catch с WARN log)
  - **`/recurrent`**: то же что `/pay`, НО `UPDATE WHERE status='active'` (cancelled НЕ продлевается), `expires_at = expires_at + 30 days` (extend, не from now), receipt period = `(OLD expires_at, NEW expires_at)` — точная пара для 54-ФЗ чеков, kind=`'subscription_renewed'`
  - **`/fail`**: `UPDATE active → 'paused_payment_failed'`, receipt с `is_failed=true` и нулевым периодом `(now, now)`, kind=`'payment_failed'`, notify в try/catch с **`log.error`** (не warn — критично, юзер должен узнать о проблеме до окончания grace)
- **Webhook security**: HTTP коды строго по протоколу CloudPayments — `403` на HMAC mismatch (CloudPayments не ретраит атаку), `200 + {code:0}` на idempotent skip / sub-not-found / 0-rows-update (CloudPayments не ретраит), `500` на transient ошибки БД (CloudPayments повторит)
- **Raw body перед JSON.parse**: webhook handlers НЕ используют `parseJsonBody` — `event.body` берётся as-is для HMAC verify, JSON.parse только после успешной проверки подписи (иначе порядок ключей при stringify сломал бы HMAC)
- **`signCpWebhook(rawBody)` helper** в `test/helpers.js` + `setTestCpSecrets()` / `resetTestCpSecrets()` для setup тестовых env

**30 новых тестов**: A1–A5 cloudpayments-lib, B1–B10 webhook/pay, C1–C5 webhook/recurrent, D1–D5 webhook/fail, E1–E5 subscription-start widget_config.

Покрытие тестами: **92.05%** line / **96.00%** funcs (private-api), **642 теста** (24 public + 618 private). Стабильность подтверждена 5 последовательными прогонами.

## Этап 6 — приватный API закрыт

Все 11 подэтапов (6.1–6.11) завершены и покрыты тестами. Backend готов к деплою при разморозке Yandex Cloud.

**Итого `private-api/`:**

| Показатель | Значение |
|---|---|
| Под-этапов | 11 / 11 (6.1–6.11) |
| Тестов | **585** private + **24** public = **609** |
| Покрытие строк | **~93%** |
| Покрытие функций | **~95%** |
| Миграций | 014 (001–014) |
| Cloud Functions | 21 (HTTP + Timer) |
| Handlers | 30+ (`/auth/*`, `/auth/email/*`, `/subscription/*`, `/account/*`, `/coupons/{id}/*`, `/admin/parser/*`, `/support/*`, `/events/*`) |
| Cron | 3 (`scheduled-deletions` каждый час, `events-cleanup` ежедневно, `mock-daily-charges` staging) |
| Middleware | `requireUser`, `requireParserSecret`, `corsHeaders` |
| Lib-модули | billing-config, mock-cron, parser-config, notifications, sms-provider, email-provider, events-config, events-cleanup, events-rate-limit, support-config, account-deletion-config, account-cleanup, response, mask-pii, rate-limit |

**Защитные механизмы:**
- `assertNoMockInProduction()` — fail-fast при импорте + при вызове mock-cron
- `check-no-mock-in-prod.sh` — CI-guard HARD-FAIL на `STUB_TODO` перед каждым деплоем
- `crypto.timingSafeEqual` — сравнение секретов парсера
- OTP confirm + 24h grace period — для удаления аккаунта
- `UPDATE … RETURNING` атомарный claim — идемпотентный cron-cleanup
- Маскирование PII во всех логах (`maskPhone`, `maskEmail`, `maskToken`, `maskIp`)

**Ожидается:**
- **Этап 10**: Операторский биллинг (Мегафон/Билайн/Т2) — после подписания договоров с операторами связи
- **Этап 11**: Логотипы магазинов
- **Деплой**: разморозка Yandex Cloud → 30 минут по `README_DEPLOY.md` → `docs/PRE_DEPLOY_CHECKLIST.md`
| Lib-модули | billing-config, mock-cron, parser-config, notifications, sms-provider, events-config, events-cleanup, events-rate-limit, support-config, account-deletion-config, account-cleanup, response, mask-pii, rate-limit |

## Связь с другими репо

- **`gdekod-frontend`** — лендинг `gde-code.ru`, дёргает `public-api` через `fetch`.
- **`gdekod-frontend/database/postgresql/`** — миграции PG (схема `public_data` для публичного API + `coupons` / `merchants` / `categories` / `coupon_checks` под Этап 8).

## Принципы

- **Каждый эндпоинт — отдельная Cloud Function.** Маршрутизация через Yandex API Gateway. Cold-start экономим переиспользованием PG pool через module-level singleton (см. `public-api/lib/db.js`).
- **Stack trace не уходит клиенту.** Только `{ error, requestId }`. Подробности — в `console.error`, попадают в Yandex Cloud Logging.
- **Параметризованные запросы везде** (`$1, $2, ...`). Никаких склеек строк в SQL.
- **Секреты — из Yandex Lockbox**, не из `.env` в репо. Локально для отладки — `cp .env.example .env`, заполнить.
- **Read-only пользователь PG для публичного API.** Отдельный `public_api_reader` с `GRANT SELECT ON SCHEMA public_data` и больше ничем.
- **CORS whitelist** — только `https://gde-code.ru` и `https://www.gde-code.ru`.

## Что НЕ в этом репо

- **Фронт** (`gde-code.ru` SPA) — `gdekod-frontend`.
- **Платёжный шлюз и админка** — будут отдельным backend'ом, отдельным доменом (`admin.gde-code.ru`), чтобы скомпрометированный публичный API не мог дёрнуть админские ручки.
- **Долгие фоновые задачи**, кроме периодической автопроверки — этого пока нет. Если появятся — Yandex Cloud Triggers + отдельные функции.
