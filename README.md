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
| `private-api/` | Auth + email-привязка (`/auth/*`, `/auth/email/*`), `requireUser` middleware, rate-limit, mask-pii | 🟡 6.1–6.4 готовы, 6.5–6.11 в работе | 267 / 267 (`node:test`), coverage 93.24% |

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
| 6.5–6.11 | Приватный API: сессии, подписки, аккаунт, парсер, 152-ФЗ, support, финал | `private-api/` | — |
| 7 | Платежи (CloudPayments + операторский биллинг) | внутри этапа 6 | — |
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
