# PRE_DEPLOY_CHECKLIST.md — Чек-лист перед первым production deploy

Проходить **сверху вниз**. Каждый пункт — условие для следующего.  
Деплоить только когда все пункты отмечены `[x]`.

---

## 1. Yandex Cloud — доступ и инфраструктура

- [ ] Yandex Cloud аккаунт верифицирован, billing включён и пополнен
- [ ] Создан folder `gdekod-prod` (или аналогичный) с понятным именем
- [ ] Создан сервисный аккаунт для Cloud Functions с ролями:
  - `serverless.functions.admin`
  - `lockbox.payloadViewer`
  - `mdb.viewer`
- [ ] `yc` CLI настроен и авторизован: `yc config list` показывает нужный folder-id

---

## 2. База данных — PostgreSQL

- [ ] Создан кластер Yandex Managed PostgreSQL (минимум: 2 ГБ RAM, 10 ГБ диск)
- [ ] Создана база данных `gdekod`
- [ ] Созданы два пользователя БД:
  - `public_api_reader` — `SELECT` на схему `public_data`
  - `private_api_writer` — `SELECT/INSERT/UPDATE/DELETE` на `private_data`, `SELECT` на `public_data`
- [ ] Скачан CA-сертификат Yandex Cloud (`CA.pem`), проверено SSL-соединение:
  ```
  psql "host=... sslmode=verify-full sslrootcert=CA.pem ..."
  ```
- [ ] Все миграции применены (`001` → `014`) без ошибок
- [ ] **REAL_PG_CHECKLIST пройден** (`migrations/REAL_PG_CHECKLIST.md`) — все 12 пунктов:
  - Триггер `trg_users_updated_at` обновляет `updated_at`
  - `gen_random_uuid()` работает (extension pgcrypto)
  - Round-trip миграций без артефактов
  - Partial-индексы не ломают SELECT (quirk pg-mem не воспроизводится)
  - Остальные 8 пунктов из файла

---

## 3. Секреты — Yandex Lockbox

- [ ] Сгенерированы все криптостойкие секреты (`crypto.randomBytes(32).toString('base64')`)
- [ ] Создан Lockbox-секрет `gdekod-private-api-secrets` с ключами:
  - `JWT_SECRET` (≥ 32 байт base64)
  - `OTP_HMAC_SECRET` (≥ 32 байт base64)
  - `PARSER_SECRET` (≥ 32 байт base64)
  - `PRIVATE_API_HEALTH_TOKEN`
  - `YANDEX_PG_HOST`, `YANDEX_PG_PASSWORD`
  - `SMS_RU_API_ID`
  - `YANDEX_POSTBOX_SMTP_PASSWORD`
- [ ] Создан Lockbox-секрет `gdekod-public-api-secrets`:
  - `PUBLIC_API_HEALTH_TOKEN`
  - `YANDEX_PG_HOST`, `YANDEX_PG_PASSWORD`
- [ ] Сервисный аккаунт функций имеет роль `lockbox.payloadViewer` на оба секрета
- [ ] Секреты не хранятся в репо, в чатах, в `.env` файлах с доступом третьим лицам

---

## 4. Внешние провайдеры

- [ ] **SMS.ru**: аккаунт верифицирован, баланс пополнен, API-ключ получен и добавлен в Lockbox
- [ ] **Yandex Postbox**:
  - Домен `gde-code.ru` верифицирован в Postbox
  - DNS-записи настроены: SPF, DKIM, DMARC через Cloudflare
  - Адрес `noreply@gde-code.ru` подтверждён
  - SMTP-пароль добавлен в Lockbox
- [ ] **CloudPayments** (этап 7, без этого биллинг через CP недоступен):
  - [ ] Модерация пройдена
  - [ ] Получены тестовые ключи (`Public ID` + `API Secret`)
  - [ ] `STUB_TODO_STAGE_7` в `subscription/start.js` заменён на реальную интеграцию
  - [ ] `scripts/check-no-mock-in-prod.sh` проходит без HARD-FAIL

---

## 5. Cloud Functions — деплой

- [ ] Создана Cloud Function для каждого handler'а (список в `README_DEPLOY.md`)
- [ ] Каждая функция:
  - Привязана к Lockbox-секрету через `--secret`
  - Имеет `NODE_ENV=production`
  - Имеет `MOCK_OPERATOR_BILLING=false`
  - Имеет `GIT_SHA=$(git rev-parse HEAD)`
- [ ] Cron-функции созданы и привязаны к Timer Trigger:
  - `scheduled-deletions` — каждый час (`0 * ? * * *`)
  - `events-cleanup` — раз в день в 03:00 UTC (`0 3 ? * * *`)
  - `mock-daily-charges` — **только на staging**, не на production

---

## 6. API Gateway и сеть

- [ ] Yandex API Gateway настроен, все маршруты прописаны (публичный + приватный API)
- [ ] CORS настроен: только `https://gde-code.ru` и `https://www.gde-code.ru`
- [ ] Public-api функции используют `public_api_reader` (не `private_api_writer`)

---

## 7. Фронтенд — gdekod-frontend

- [ ] `gdekod-frontend` собран (`npm run build`) и задеплоен на Yandex Object Storage
- [ ] CDN настроен перед Object Storage (Yandex CDN или CloudFront-аналог)
- [ ] **CDN настроен на `index.html` для SPA routes** — custom 404 handler возвращает  
  `index.html` со статусом 200 (иначе прямые ссылки на `/coupons/123` дадут 404)
- [ ] DNS-записи `gde-code.ru` и `www.gde-code.ru` указывают на CDN (не напрямую на Object Storage)
- [ ] SSL-сертификат активен, HTTPS работает, HTTP редиректит на HTTPS
- [ ] Редирект `где-код.рф` → `gde-code.ru` через Cloudflare работает (NS-пропагация завершена)

---

## 8. Проверка защитных механизмов

- [ ] `assertNoMockInProduction()` проверена в isolation:
  ```bash
  NODE_ENV=production MOCK_OPERATOR_BILLING=true \
  node -e "import('./private-api/lib/billing-config.js')" 2>&1 | grep CRITICAL
  ```
  Должно выдать `CRITICAL: MOCK_OPERATOR_BILLING=true in production`

- [ ] `scripts/check-no-mock-in-prod.sh` запущен и прошёл без HARD-FAIL  
  (STUB_TODO не должен остаться после реализации CloudPayments в этапе 7)

- [ ] `GET /health` с правильным Bearer → `status: 'ok'`, `service: 'private'`, `db: true`

---

## 9. Smoke-тест после деплоя

- [ ] `bash scripts/smoke-test.sh <API_URL> <HEALTH_TOKEN>` — **все 8 проверок зелёные**

---

## 10. Команда и документация

- [ ] Команда тестирования получила:
  - Ссылку на staging-окружение
  - Bearer-токены для `/health` (не production-токены!)
  - Контакт ответственного за Yandex Cloud (для инцидентов)
- [ ] `docs/REAL_PG_CHECKLIST.md` заполнен результатами реального прогона на staging БД
- [ ] Этот чек-лист обновлён датой и подписью: **Прошёл деплой: __ . __ . 2026**

---

## Быстрая справка — что делать если что-то пошло не так

| Симптом | Первый шаг |
|---|---|
| Функция возвращает 500 | `yc serverless function logs --function-name <name>` |
| JWT_SECRET не задан | Проверить `--secret` параметры версии функции |
| БД недоступна | Проверить YANDEX_PG_HOST и порт (6432, не 5432) |
| MOCK_OPERATOR_BILLING в production | Исправить env, задеплоить новую версию |
| Миграция не применилась | Подключиться напрямую psql и проверить `\dt private_data.*` |
| Cron не запускается | `yc serverless trigger list` + проверить роль SA |
