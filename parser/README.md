# gdekod-parser

Парсер промокодов на Playwright + Azure для сервиса ГдеКод.

Соответствует ТЗ v14, разделы §20 (парсер), §9 (tiered scheduling).

## Что делает

- Запускает реальный Chromium через Playwright
- Заходит на сайт магазина как живой пользователь
- Вводит промокод в корзине
- Считывает результат: сработал / истёк / непонятно
- Отправляет статус в Yandex API → попадает в БД
- Поддерживает реактивные перепроверки по жалобам

## Архитектура

```
checker.js     → проверка одного промокода через Playwright
reporter.js    → отправка результатов в Yandex API
queue.js       → очередь срочных перепроверок (по жалобам)
scheduler.js   → tiered scheduling, точка входа
timer-trigger/ → Azure Functions для CRON-запусков
merchants/     → JSON-конфиги селекторов для каждого магазина
test/          → одиночные тесты без API
```

## Tiered scheduling

| Tier | CRON (UTC) | МСК | Промокодов |
|------|------------|-----|------------|
| 1 | `0 0,3,6,9,12,15,18,21 * * *` | каждые 3ч | ~200 |
| 2 | `0 1,9,17 * * *` | каждые 8ч | ~500 |
| 3 | `0 2 * * *` | раз в сутки в 05:00 | ~1300 |
| Urgent | `*/5 * * * *` | каждые 5 минут | по жалобам |

Jitter ±10 минут для tier 2 и 3 — не палим паттерн ботов.

## Логика порогов жалоб (§20.4)

| Жалоб за час | Действие |
|--------------|----------|
| 1–2 | Только пишем в БД, код продолжает показываться |
| 3 | Срочная перепроверка → urgent queue |
| 5 + парсер подтвердил `expired` | Авто-удаление из каталога |
| 10 | Задача оператору с приоритетом «срочно» |

★ Эта логика частично реализуется на стороне Yandex API (этап 6) — парсер только обрабатывает сигналы из urgent queue.

## Локальный запуск

```bash
# 1. Установить зависимости
npm install
npx playwright install chromium --with-deps

# 2. Скопировать .env.example → .env, заполнить PARSER_SECRET_KEY

# 3. Тест одного промокода без API (для разработки селекторов)
npm run test:single -- merchants/wildberries.json TESTPROMO

# 4. Запустить tier полностью (требует доступ к Yandex API)
npm run tier1
npm run tier2
npm run tier3
npm run urgent
```

## Деплой в Azure

Два компонента:

**1. Container Instance с Playwright** — образ из Dockerfile:

```bash
# Сборка и пуш в Azure Container Registry
az acr build --registry gdekodacr --image gdekod-parser:latest .

# Создание Container Instance (под одной задачей tier)
az container create \
  --resource-group gdekod-rg \
  --name parser-tier1 \
  --image gdekodacr.azurecr.io/gdekod-parser:latest \
  --cpu 2 --memory 4 \
  --restart-policy Never \
  --environment-variables \
    PARSER_TIER=1 \
    YANDEX_API_URL=https://api.gde-code.ru \
    PARSER_SECRET_KEY=<секрет>
```

**2. Functions Timer Trigger** — деплоится как Azure Functions проект:

```bash
cd timer-trigger
func azure functionapp publish gdekod-parser-functions
```

Functions запускают `az container start parser-tierN` по расписанию.

## Бюджет (по ТЗ §20.9)

| Компонент | $/мес | Источник |
|-----------|-------|----------|
| Container Instances | 30–40 | кредиты Microsoft |
| Azure OpenAI (нормализация — этап 9.5) | 5–10 | кредиты Microsoft |
| Functions Timer | 1–2 | кредиты Microsoft |
| **Итого** | **35–50** | хватит на 16–25 месяцев |

## 152-ФЗ — критично

★ Парсер НЕ хранит и НЕ передаёт никаких ПД пользователей.

- В Azure-логах нет `user_id`, `phone`, `email`
- В Yandex API передаются только: `coupon_id`, `status`, `checked_at`, `error`
- Жалобы и подтверждения хранятся в Yandex (Москва), не в Azure
- Парсер запрашивает урgent-очередь по `coupon_id` без привязки к юзеру

## API контракт с Yandex

Парсер использует 3 эндпоинта Yandex API (этап 6):

| Метод | Эндпоинт | Назначение |
|-------|----------|------------|
| GET | `/api/admin/parser/coupons?tier=N&offset=…` | Список промокодов на проверку |
| GET | `/api/admin/parser/urgent-queue` | Срочная очередь по жалобам |
| GET | `/api/admin/parser/coupon/{id}` | Полные данные одного промокода |
| POST | `/api/admin/parser/result` | Запись результата проверки |

Все запросы аутентифицируются заголовком `X-Parser-Secret`.

## Что НЕ делает парсер (out of scope)

- Сбор новых промокодов (это другой компонент — AI-парсер агрегаторов, этап 9.5)
- Сохранение скриншотов (только в режиме отладки)
- Уведомления операторам (это делает Power Automate из Yandex API)
- Хранение жалоб (это БД в Yandex)
