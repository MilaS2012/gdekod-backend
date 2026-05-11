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
| `src/handlers/private/` | Auth, subscription, account, support | план (README с дизайном) | — |

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

## Этапы по ТЗ v14 §22

Верхнеуровневый трекинг по проекту в целом (не только этот репо):

| Этап | Что | Где | Статус |
|---|---|---|---|
| 1 | HTML → React + Vite | `gdekod-frontend/` | ✓ |
| 2 | Схема Azure SQL Database | `gdekod-frontend/database/` | ✓ |
| 2.5 | Миграция на PostgreSQL + connection-example + deploy-скрипты на Yandex Object Storage | `gdekod-frontend/database/postgresql/` + `gdekod-frontend/deploy/` + `database/` (TBD) | ✓ |
| 2.6 | Визуал v14 (бейдж свежести, голосование) | `gdekod-frontend/src/` | ✓ |
| 3.1 | Backend-каркас | этот репо | заменён этапами 5+8 |
| 4 | Yandex Cloud setup | — | блокирован верификацией платёжного аккаунта |
| **5** | **Публичный API (read-only)** | `public-api/` | **✓** |
| 6 | Приватный API (auth, subscription, account, support) | `src/handlers/private/` (план) | — |
| 7 | Платежи (ЮKassa / CloudPayments) | внутри этапа 6 | — |
| **8** | **Парсер промокодов (Playwright + tiered scheduling)** | `parser/` | **✓** |
| 9 | Деплой и подключение домена | `gdekod-frontend/deploy/` | DNS-часть подготовлена, Yandex деплой — после этапа 4 |
| 10 | Мониторинг и алерты | — | после стабилизации деплоя |

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
