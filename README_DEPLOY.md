# README_DEPLOY.md — Руководство по деплою gdekod-backend

Пошаговая инструкция для первого деплоя в Yandex Cloud.  
Предполагается что аккаунт верифицирован и billing включён.

---

## Предварительные требования

| Инструмент | Версия | Зачем |
|---|---|---|
| `yc` CLI | ≥ 0.120 | Создание функций, Lockbox |
| `node` | ≥ 20 | Локальная генерация секретов |
| `psql` | любая | Применение миграций |
| `git` | любая | GIT_SHA для функций |
| `curl` | любая | Smoke-тест |

Установка yc CLI:
```bash
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
yc init   # логин через browser
```

---

## Шаг 1 — Генерация криптостойких секретов

Генерируем все секреты **локально** перед созданием Lockbox.  
Никогда не используем слабые или предсказуемые значения.

```bash
# JWT_SECRET — подпись JWT (инвалидирует все сессии при смене)
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"

# OTP_HMAC_SECRET — HMAC для хеширования OTP в БД
node -e "console.log('OTP_HMAC_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"

# PARSER_SECRET — shared secret между парсером (Azure) и private-api
node -e "console.log('PARSER_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"

# PRIVATE_API_HEALTH_TOKEN — Bearer для /health мониторинга
node -e "console.log('PRIVATE_API_HEALTH_TOKEN=' + require('crypto').randomBytes(24).toString('base64'))"

# PUBLIC_API_HEALTH_TOKEN — то же для public-api
node -e "console.log('PUBLIC_API_HEALTH_TOKEN=' + require('crypto').randomBytes(24).toString('base64'))"
```

Сохраните результат в защищённое место (1Password, Bitwarden) —  
**после сохранения в Lockbox оригинал в консоли больше не нужен**.

---

## Шаг 2 — Yandex Lockbox: создание секретов

Lockbox хранит секреты и монтирует их как env-переменные в Cloud Functions.  
Каждую функцию можно привязать к одному или нескольким секретам.

### 2.1 Создать секрет для private-api

```bash
# Создаём секрет (название произвольное, главное — запомнить ID)
yc lockbox secret create \
  --name gdekod-private-api-secrets \
  --payload '[
    {"key": "JWT_SECRET",                "textValue": "<сгенерированное>"},
    {"key": "OTP_HMAC_SECRET",           "textValue": "<сгенерированное>"},
    {"key": "PARSER_SECRET",             "textValue": "<сгенерированное>"},
    {"key": "PRIVATE_API_HEALTH_TOKEN",  "textValue": "<сгенерированное>"},
    {"key": "YANDEX_PG_PASSWORD",        "textValue": "<пароль private_api_writer>"},
    {"key": "YANDEX_PG_HOST",            "textValue": "rc1b-xxxxxxxx.mdb.yandexcloud.net"},
    {"key": "SMS_RU_API_ID",             "textValue": "<из SMS.ru>"},
    {"key": "YANDEX_POSTBOX_SMTP_PASSWORD", "textValue": "<из Postbox>"}
  ]'

# Запомнить secret ID (понадобится при создании функций)
yc lockbox secret list
```

### 2.2 Создать секрет для public-api

```bash
yc lockbox secret create \
  --name gdekod-public-api-secrets \
  --payload '[
    {"key": "PUBLIC_API_HEALTH_TOKEN", "textValue": "<сгенерированное>"},
    {"key": "YANDEX_PG_PASSWORD",      "textValue": "<пароль public_api_reader>"}
  ]'
```

### 2.3 Проверить доступ сервисного аккаунта к Lockbox

```bash
# Сервисный аккаунт функций должен иметь роль lockbox.payloadViewer
yc iam service-account list
yc lockbox secret add-access-binding \
  --name gdekod-private-api-secrets \
  --role lockbox.payloadViewer \
  --service-account-name <имя сервисного аккаунта>
```

---

## Шаг 3 — PostgreSQL: применение миграций

```bash
# Скачать CA-сертификат Yandex Cloud для SSL
curl -o ~/CA.pem https://storage.yandexcloud.net/cloud-certs/CA.pem

# Подключиться к БД (через pgbouncer обычно не разрешает DDL — подключаемся на 5432 для миграций)
psql "host=<YANDEX_PG_HOST> port=5432 dbname=gdekod user=<admin> sslmode=verify-full sslrootcert=~/CA.pem"

# Применить все миграции по порядку
\i migrations/001_initial.sql
\i migrations/002_magic_links.sql
\i migrations/003_auth_sessions.sql
\i migrations/004_email_verify.sql
\i migrations/005_subscription_receipts.sql
\i migrations/006_coupon_votes_reveals.sql
\i migrations/007_session_ua.sql
\i migrations/008_subscriptions_v2.sql
\i migrations/009_receipts_is_mock.sql
\i migrations/010_coupon_stats.sql
\i migrations/011_account_profile.sql
\i migrations/012_parser_fields.sql
\i migrations/013_support_and_events.sql
\i migrations/014_account_deletion.sql

# Проверить схему
\dn          -- должны быть: private_data, public_data
\dt private_data.*
\dt public_data.*
```

После этого пройти **REAL_PG_CHECKLIST** из `migrations/REAL_PG_CHECKLIST.md`.

---

## Шаг 4 — Создание Cloud Functions

### 4.1 Передача GIT_SHA в Cloud Function

GIT_SHA передаётся при создании версии функции через `--environment`.  
Это позволяет отображать в `/health` какая именно версия задеплоена:

```bash
GIT_SHA=$(git rev-parse HEAD)

yc serverless function version create \
  --function-name gdekod-private-auth-start \
  --runtime nodejs20 \
  --entrypoint handlers/auth/start.handler \
  --memory 128m \
  --execution-timeout 10s \
  --environment GIT_SHA="$GIT_SHA" \
  --environment NODE_ENV=production \
  --environment MOCK_OPERATOR_BILLING=false \
  --environment YANDEX_PG_PORT=6432 \
  --environment YANDEX_PG_USER=private_api_writer \
  --environment YANDEX_PG_DATABASE=gdekod \
  --secret environment-variable=JWT_SECRET,name=gdekod-private-api-secrets,key=JWT_SECRET \
  --secret environment-variable=OTP_HMAC_SECRET,name=gdekod-private-api-secrets,key=OTP_HMAC_SECRET \
  --secret environment-variable=YANDEX_PG_PASSWORD,name=gdekod-private-api-secrets,key=YANDEX_PG_PASSWORD \
  --secret environment-variable=YANDEX_PG_HOST,name=gdekod-private-api-secrets,key=YANDEX_PG_HOST \
  --service-account-id <SERVICE_ACCOUNT_ID> \
  --source-path private-api/
```

> **Почему GIT_SHA передаётся через `--environment` а не через Lockbox?**  
> GIT_SHA меняется при каждом деплое — это не секрет, а метаданные конкретной версии.
> Секреты (JWT_SECRET и т.п.) меняются редко и хранятся в Lockbox.
> Без `GIT_SHA` `/health` вернёт `version: 'dev'` — это допустимо, но неудобно для отладки.

### 4.2 Пример для health endpoint

```bash
yc serverless function version create \
  --function-name gdekod-private-health \
  --runtime nodejs20 \
  --entrypoint handlers/health.handler \
  --memory 128m \
  --execution-timeout 5s \
  --environment GIT_SHA="$GIT_SHA" \
  --environment NODE_ENV=production \
  --environment YANDEX_PG_PORT=6432 \
  --environment YANDEX_PG_USER=private_api_writer \
  --environment YANDEX_PG_DATABASE=gdekod \
  --secret environment-variable=PRIVATE_API_HEALTH_TOKEN,name=gdekod-private-api-secrets,key=PRIVATE_API_HEALTH_TOKEN \
  --secret environment-variable=YANDEX_PG_PASSWORD,name=gdekod-private-api-secrets,key=YANDEX_PG_PASSWORD \
  --secret environment-variable=YANDEX_PG_HOST,name=gdekod-private-api-secrets,key=YANDEX_PG_HOST \
  --service-account-id <SERVICE_ACCOUNT_ID> \
  --source-path private-api/
```

### 4.3 Cron-функции (Timer Triggers)

```bash
# scheduled-deletions — каждый час
yc serverless function version create \
  --function-name gdekod-cron-scheduled-deletions \
  --runtime nodejs20 \
  --entrypoint cron/scheduled-deletions.handler \
  --memory 128m \
  --execution-timeout 60s \
  --environment GIT_SHA="$GIT_SHA" \
  --environment NODE_ENV=production \
  --environment YANDEX_PG_PORT=6432 \
  --environment YANDEX_PG_USER=private_api_writer \
  --environment YANDEX_PG_DATABASE=gdekod \
  --secret environment-variable=YANDEX_PG_PASSWORD,name=gdekod-private-api-secrets,key=YANDEX_PG_PASSWORD \
  --secret environment-variable=YANDEX_PG_HOST,name=gdekod-private-api-secrets,key=YANDEX_PG_HOST \
  --service-account-id <SERVICE_ACCOUNT_ID> \
  --source-path private-api/

# Создать Timer Trigger (каждый час в :00)
yc serverless trigger create timer \
  --name gdekod-trigger-scheduled-deletions \
  --cron-expression "0 * ? * * *" \
  --invoke-function-name gdekod-cron-scheduled-deletions \
  --invoke-function-service-account-name <SERVICE_ACCOUNT_NAME>

# events-cleanup — раз в день в 03:00 UTC
yc serverless trigger create timer \
  --name gdekod-trigger-events-cleanup \
  --cron-expression "0 3 ? * * *" \
  --invoke-function-name gdekod-cron-events-cleanup \
  --invoke-function-service-account-name <SERVICE_ACCOUNT_NAME>

# mock-daily-charges — только на STAGING (не production!)
# NODE_ENV=staging, MOCK_OPERATOR_BILLING=true
# Запускать раз в сутки в 00:01 UTC
```

---

## Шаг 5 — Smoke-тест после деплоя

```bash
# Убедитесь что API Gateway настроен и URL известен
API_URL="https://api.gde-code.ru"

# HEALTH_TOKEN берётся из Lockbox (или задаётся в CI secrets)
HEALTH_TOKEN="$(yc lockbox payload get --name gdekod-private-api-secrets --key PRIVATE_API_HEALTH_TOKEN)"

bash scripts/smoke-test.sh "$API_URL" "$HEALTH_TOKEN"
```

Ожидаемый вывод: все 8 проверок зелёные, `exit 0`.

---

## Шаг 6 — Настройка мониторинга

```bash
# Yandex Monitoring: алерт если /health возвращает != 200
# UptimeRobot (бесплатный план): проверка каждые 5 минут
# Настройка аналогична — URL: https://api.gde-code.ru/health
# Headers: Authorization: Bearer <HEALTH_TOKEN>
```

---

## Структура Cloud Functions

| Функция | Entrypoint | Trigger |
|---|---|---|
| `gdekod-public-merchants-list` | `handlers/merchants-list.handler` | HTTP |
| `gdekod-public-merchant-detail` | `handlers/merchant-detail.handler` | HTTP |
| `gdekod-public-coupons-list` | `handlers/coupons-list.handler` | HTTP |
| `gdekod-public-coupon-detail` | `handlers/coupon-detail.handler` | HTTP |
| `gdekod-public-health` | `handlers/health.handler` | HTTP |
| `gdekod-private-auth-start` | `handlers/auth/start.handler` | HTTP |
| `gdekod-private-auth-verify` | `handlers/auth/verify.handler` | HTTP |
| `gdekod-private-auth-login-magic` | `handlers/auth/login-magic.handler` | HTTP |
| `gdekod-private-auth-sessions` | `handlers/auth/sessions.handler` | HTTP |
| `gdekod-private-auth-logout-all` | `handlers/auth/logout-all.handler` | HTTP |
| `gdekod-private-auth-email-*` | `handlers/auth/email/*.handler` | HTTP |
| `gdekod-private-subscription-*` | `handlers/subscription/*.handler` | HTTP |
| `gdekod-private-account-*` | `handlers/account/*.handler` | HTTP |
| `gdekod-private-coupons-*` | `handlers/coupons/*.handler` | HTTP |
| `gdekod-private-admin-parser-*` | `handlers/admin/parser/*.handler` | HTTP |
| `gdekod-private-support-*` | `handlers/support/*.handler` | HTTP |
| `gdekod-private-events-log` | `handlers/events/log.handler` | HTTP |
| `gdekod-private-health` | `handlers/health.handler` | HTTP |
| `gdekod-cron-scheduled-deletions` | `cron/scheduled-deletions.handler` | Timer (1h) |
| `gdekod-cron-events-cleanup` | `cron/events-cleanup.handler` | Timer (daily 03:00) |
| `gdekod-cron-mock-charges` | `cron/mock-daily-charges.handler` | Timer (daily, staging only) |

---

## Откат (Rollback)

```bash
# Показать предыдущие версии функции
yc serverless function version list --function-name gdekod-private-auth-start

# Переключить трафик на предыдущую версию (по version ID)
yc serverless function set-scaling-policy \
  --function-name gdekod-private-auth-start \
  --tag latest \
  --version-id <PREVIOUS_VERSION_ID>
```

Откат миграций БД — по файлам `migrations/rollback/` в обратном порядке.  
**ВНИМАНИЕ:** откат 001 удаляет ВСЕ таблицы — только при критической аварии!

---

## Частые ошибки

| Ошибка | Причина | Решение |
|---|---|---|
| `JWT_SECRET не задан` | Lockbox не привязан к функции | Проверить `--secret` параметры при создании версии |
| `getaddrinfo ENOTFOUND` | YANDEX_PG_HOST не задан | Добавить хост в Lockbox и привязать к функции |
| `CRITICAL: MOCK_OPERATOR_BILLING=true in production` | Ошибка конфигурации | Установить `MOCK_OPERATOR_BILLING=false` |
| `health: PRIVATE_API_HEALTH_TOKEN не задан — endpoint заблокирован` | Нет токена в env | Добавить в Lockbox и привязать |
| `connection timeout` | Порт 5432 вместо 6432 | Использовать `YANDEX_PG_PORT=6432` (pgbouncer) |
