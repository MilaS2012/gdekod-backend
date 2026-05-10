# gdekod-backend

Backend API для сервиса **ГдеКод** (`gde-code.ru`) — каталог промокодов российских интернет-магазинов.

Бекенд построен на **Yandex Cloud Functions** (serverless, аналог AWS Lambda) с подключением к **Yandex Managed PostgreSQL**. Каждый эндпоинт — отдельная функция; маршрутизация — через **Yandex API Gateway**.

## Структура проекта

```
.
├── README.md                     ← этот файл
├── package.json                  ← зависимости + npm-скрипты
├── .env.example                  ← шаблон env-переменных (без секретов)
├── src/
│   ├── config.js                 ← чтение env с проверкой обязательных переменных
│   ├── handlers/
│   │   ├── public/               ← публичный API без авторизации
│   │   │   ├── merchants.js      ← GET /merchants, GET /merchants/{id}
│   │   │   └── coupons.js        ← GET /coupons, GET /coupons/{id}
│   │   └── private/              ← приватный API (план — см. private/README.md)
│   ├── db/
│   │   ├── client.js             ← PG pool, переиспользуется между warm-вызовами
│   │   └── queries/
│   │       ├── merchants.js
│   │       └── coupons.js
│   └── utils/
│       ├── response.js           ← хелперы JSON-ответов (ok, notFound, serverError…)
│       └── cors.js               ← CORS-заголовки под gde-code.ru
└── tests/                        ← план тестов на Vitest (см. tests/README.md)
```

## Endpoints (публичный API)

| Метод | Путь | Что возвращает |
|---|---|---|
| `GET` | `/merchants` | Список активных магазинов. Опц. `?category=eda`. |
| `GET` | `/merchants/{id}` | Один магазин по id. 404, если нет или скрыт. |
| `GET` | `/coupons` | Список активных промокодов. Опц. `?merchant_id=N`. |
| `GET` | `/coupons/{id}` | Один промокод. 404, если не active/удалён. |

Только активные сущности (`merchants.is_active = true`, `coupons.status = 'active'`) — `expired`, `removed`, `needs_manual_check` скрыты.

## Принципы реализации handler'ов

1. **Стандартизованный ответ** — все handler'ы возвращают через `src/utils/response.js` (ok / badRequest / notFound / methodNotAllowed / serverError / corsPreflightResponse). Никаких ручных `{ statusCode, body }` в коде handler'ов.
2. **CORS** — заголовки добавляются автоматически через `src/utils/cors.js`. Whitelist: `https://gde-code.ru`, `https://www.gde-code.ru`. Origin вне списка → fallback `https://gde-code.ru` (браузер всё равно заблокирует ответ).
3. **Переиспользование PG pool** — `src/db/client.js` создаёт `pg.Pool` один раз на cold-start через module-level singleton. Все warm-инвокации того же контейнера используют тот же pool.
4. **Логирование ошибок** — только `console.error('[handler-name]', { requestId, err })`. stdout/stderr Cloud Functions автоматически уходят в **Yandex Cloud Logging** — отдельной библиотеки логирования не подключаем.
5. **Никогда не отдаём stack trace клиенту.** При ошибке клиент получает `{ error: "Internal server error", requestId }` — id для саппорта, ничего больше. Подробности — только в логе.

## Переменные окружения

См. `.env.example`. Минимум:

```
YANDEX_PG_HOST       FQDN мастера кластера (rc1a-xxxxxxxx.mdb.yandexcloud.net)
YANDEX_PG_PORT       6432 (pgbouncer — обязательно для serverless)
YANDEX_PG_USER       пользователь БД
YANDEX_PG_PASSWORD   пароль БД (в проде — из Lockbox, не в .env)
YANDEX_PG_DATABASE   имя БД (gdekod)
YANDEX_PG_CA_CERT    CA-сертификат YC, PEM-содержимое одной переменной
```

В Yandex Cloud Functions реальные значения подаются через **Yandex Lockbox** → монтируются как env-переменные функции. Локально для отладки — `cp .env.example .env`, заполнить.

## Как этим пользоваться

Когда платёжный аккаунт в YC будет верифицирован:

```bash
# 1. Установить зависимости (один раз)
npm install

# 2. Установить и настроить yc CLI
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
yc init

# 3. Создать функции и API Gateway в YC (см. план в issues — будет отдельный setup-скрипт)

# 4. Деплой публичного API:
npm run deploy-public
```

Каждый деплой — это `yc serverless function version create` с указанием entrypoint'а. Версии в YC иммутабельны; новый деплой = новая версия, переключение трафика — атомарно.

## Что НЕ в этом репо

- **Фронт** (`gde-code.ru` SPA) — в `gdekod-frontend`.
- **Миграции БД** — в `gdekod-frontend/database/postgresql/`. БД у нас одна на проект, миграции живут рядом с фронтом по историческим причинам (можно переехать сюда позже).
- **Админка** — отдельный backend, когда понадобится.
- **Платежи, подписки, авторизация** — `src/handlers/private/` (план — `src/handlers/private/README.md`).

## Статус

`v0.1.0` — стартовый каркас. Деплой не делали, ждём верификацию аккаунта YC. Смоук-тест и подключение к фронту — сразу после первого успешного деплоя.
