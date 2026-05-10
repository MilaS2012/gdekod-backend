# public-api/ — публичный API лендинга gde-code.ru

Read-only HTTP API без авторизации, обслуживает посетителей лендинга. По ТЗ v14 §19. Каждый эндпоинт — отдельная **Yandex Cloud Function**, маршрутизация — через **Yandex API Gateway**, данные — из **Yandex Managed PostgreSQL** (схема `public_data` по ТЗ §18.2).

## Что отдаём, что НЕ отдаём

| Что отдаём | Что не отдаём |
|---|---|
| Список магазинов (с числом активных промо) | Реальный `code` промокода — только маска `XXXX-XXXX` |
| Карточку магазина + его активные промокоды | `expired`, `removed`, `needs_manual_check` промокоды |
| Список и карточку публичных промокодов | Магазины без активных промокодов |
| `last_checked_at` как ISO 8601 | Любые ПД пользователей (их тут вообще нет) |

Реальный `code` доступен только в защищённой части API после оформления подписки — этап 6.

## Эндпоинты

| Метод | Путь | Handler |
|---|---|---|
| `GET` | `/api/merchants` | `handlers/merchants-list.js` |
| `GET` | `/api/merchants/{id}` | `handlers/merchant-detail.js` |
| `GET` | `/api/coupons` | `handlers/coupons-list.js` |
| `GET` | `/api/coupons/{id}` | `handlers/coupon-detail.js` |
| `GET` | `/health` (Bearer) | `handlers/health.js` |

### `GET /api/merchants`

Список активных магазинов. Магазины без активных промокодов скрыты.

**Query params:**
- `?category=` (опц.) — фильтр по категории (`eda`, `odezhda`, `elektronika`, `travel`, `krasota`, `other`)

**Ответ:**
```json
{
    "merchants": [
        {
            "id": 1,
            "name": "Wildberries",
            "slug": "wildberries",
            "logo_url": "https://...",
            "category": "odezhda",
            "coupons_count": 4
        }
    ]
}
```

### `GET /api/merchants/{id}`

Один магазин + его активные промокоды (с замаскированными кодами).

**Ответ:**
```json
{
    "merchant": {
        "id": 1,
        "name": "Wildberries",
        "slug": "wildberries",
        "logo_url": "https://...",
        "category": "odezhda",
        "created_at": "2026-01-01T00:00:00.000Z",
        "coupons": [
            {
                "id": 10,
                "title": "Скидка 500 ₽",
                "discount": "−500 ₽",
                "code": "XXXXXXXX",
                "last_checked_at": "2026-05-10T12:00:00.000Z",
                "expires_at": "2026-06-01T00:00:00.000Z",
                "status": "active"
            }
        ]
    }
}
```

### `GET /api/coupons`

Публичный список промокодов с пагинацией. Сортировка: по `last_checked_at DESC` (свежее — выше).

**Query params:**
- `?merchant_id=` (опц.) — фильтр по магазину
- `?category=` (опц.) — фильтр по категории магазина
- `?limit=` (опц.) — 1..100, default 20
- `?offset=` (опц.) — default 0

**Ответ:**
```json
{
    "coupons": [
        {
            "id": 10,
            "title": "Скидка 500 ₽",
            "discount": "−500 ₽",
            "code": "XXXXXXXX",
            "last_checked_at": "2026-05-10T12:00:00.000Z",
            "expires_at": "2026-06-01T00:00:00.000Z",
            "status": "active",
            "merchant": {
                "id": 1,
                "name": "Wildberries",
                "slug": "wildberries",
                "logo_url": "https://...",
                "category": "odezhda"
            }
        }
    ],
    "total": 234,
    "limit": 20,
    "offset": 0
}
```

### `GET /api/coupons/{id}`

Карточка одного промокода для гостя (тот же объект `coupon`, что в списке).

### `GET /health` (Bearer-only)

Внутренний health-check для мониторинга. Защищён Bearer-токеном из env `PUBLIC_API_HEALTH_TOKEN` (приходит из Yandex Lockbox). Без env-токена endpoint возвращает 500 — намеренно, чтобы случайно не выставить публичный health.

```
GET /health
Authorization: Bearer <PUBLIC_API_HEALTH_TOKEN>
```

```json
{ "status": "ok", "db": true, "time": "2026-05-10T12:00:00.000Z" }
```

## Принципы

1. **CORS whitelist** — только `https://gde-code.ru` и `https://www.gde-code.ru`. Чужие origin'ы получают `Access-Control-Allow-Origin: https://gde-code.ru` (fallback) — браузер блокирует ответ.
2. **Маскирование кодов** — `lib/mask-code.js` заменяет любой не-дефис на `X`. Дефисы сохраняются, чтобы пользователь видел структуру кода.
3. **Module-level pool** — `lib/db.js` создаёт `pg.Pool` лениво, один раз на cold-start. Warm-инвокации переиспользуют. `max=1`, `maxUses=1000`.
4. **Без stack trace в ответах** — клиент видит `{ error, requestId }`, всё остальное идёт в `console.error` (попадает в Yandex Cloud Logging автоматически).
5. **Параметризованные запросы** — никаких склеек строк, только `$1, $2, ...`.
6. **Логи без ПД** — это публичный API, ПД сюда не приходят. В логе пишем `requestId` + короткое сообщение об ошибке.

## Структура файлов

```
public-api/
├── package.json
├── .env.example
├── README.md (этот файл)
├── handlers/
│   ├── merchants-list.js     ← GET /api/merchants
│   ├── merchant-detail.js    ← GET /api/merchants/{id}
│   ├── coupons-list.js       ← GET /api/coupons
│   ├── coupon-detail.js      ← GET /api/coupons/{id}
│   └── health.js             ← GET /health (Bearer)
├── lib/
│   ├── db.js                 ← pg.Pool singleton + тестовые хуки
│   ├── cors.js               ← whitelist origin'ов
│   ├── mask-code.js          ← XXXX-XXXX
│   └── response.js           ← ok/notFound/serverError + corsPreflight
└── test/
    └── handlers.test.js      ← node:test, mocked PG
```

## Локально

```bash
cd public-api
npm install
npm test          # node --test, ~17 тестов; PG не нужен (моки)
```

Чтобы дёргать handler'ы вручную локально (без Cloud Functions): можно написать обёртку с http-сервером, но это не задача этого пакета — handler'ы рассчитаны на serverless event/context.

## Деплой (когда YC разблокируется)

```bash
# Каждый handler — отдельная функция в YC.
npm run deploy:merchants-list
npm run deploy:merchant-detail
npm run deploy:coupons-list
npm run deploy:coupon-detail
# Или всё сразу:
npm run deploy
```

После создания функций нужно:
1. Создать API Gateway с openapi-spec, маршруты `/api/merchants*`, `/api/coupons*` → соответствующие функции.
2. Завести Lockbox-секрет с `YANDEX_PG_PASSWORD` и `PUBLIC_API_HEALTH_TOKEN`, смонтировать в env функций.
3. Завести read-only PG-пользователя `public_api_reader` с `GRANT SELECT ON ALL TABLES IN SCHEMA public_data` — это пользователь публичного API.

## Связь с другими частями проекта

- **`gdekod-frontend`** — лендинг, который дёргает эти эндпоинты с `https://gde-code.ru` через `fetch`.
- **`../parser/`** — Playwright-парсер (этап 8), пишет в `public_data.coupons` (status, last_checked_at). Этот API только читает.
- **`../src/handlers/public/*.js`** — стартовый каркас из этапа 3.1, теперь устаревший. Удалим в отдельном коммите после переезда на `public-api/`.
