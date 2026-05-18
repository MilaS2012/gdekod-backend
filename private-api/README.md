# private-api/ — приватный API gde-code.ru

Авторизованный HTTP API с авторизацией по JWT. Обслуживает ЛК, оплату, раскрытие промокодов, привязку email, support и парсер-callback'и. По ТЗ v16 §3.6, §3.7, §19, §24.4. Каждый эндпоинт — отдельная **Yandex Cloud Function**, маршрутизация через **Yandex API Gateway**, данные в схеме **`private_data`** того же кластера, что и `public-api/`.

> ★ Этот пакет строится **этапами 6.1 — 6.11**. Сейчас (6.1) — каркас:
> структура папок, lib/-хелперы, мок-провайдеры SMS и email, health-эндпоинт
> и юнит-тесты на инфраструктуру. Auth-логика и SQL-схема — следующие подэтапы.

## Что отдаём (план)

| Группа | Эндпоинты | Этап |
|---|---|---|
| Auth basic | `/auth/start`, `/auth/verify`, `/auth/login-magic`, `/auth/logout-all`, `/auth/sessions` | 6.3, 6.5 |
| Email-привязка | `/auth/email/attach`, `/auth/email/verify`, `/auth/email/resend`, `/auth/banner/dismiss` | 6.4 |
| Подписки | `/subscription/status`, `/subscription/start`, `/subscription/cancel` | 6.6 |
| Аккаунт | `/account/profile` (GET/PATCH), `/account/coupons`, `/account/receipts` | 6.7 |
| Промокоды | `/coupons/{id}/reveal`, `/coupons/{id}/copy`, `/coupons/{id}/confirm`, `/coupons/{id}/complaint` | 6.7 |
| Парсер (Azure → YC) | `/admin/parser/coupons`, `/admin/parser/urgent-queue`, `/admin/parser/coupon/{id}`, `/admin/parser/result` | 6.8 |
| 152-ФЗ | `/account/export`, `DELETE /account` | 6.9 |
| Support и аналитика | `/support/tickets`, `/events` | 6.11 |

`POST /api/coupons/{id}/reveal` отдаёт реальный код только при активной подписке. Гостям и без подписки — `403`.

## Принципы (обязательны)

1. **PII никогда не попадает в логи.** Любое упоминание `phone`, `email`, токенов или JWT — только через `lib/mask-pii.js` (`maskPhone`, `maskEmail`, `maskToken`). В логах — только `user_id` и абстрактные сообщения. См. ТЗ §3.6, §21, §24.4.
2. **Без stack trace в ответах.** Клиент видит `{ error, requestId }`; подробности уходят в `console.error` → Yandex Cloud Logging.
3. **Параметризованные запросы.** Никаких склеек строк, только `$1, $2, ...`.
4. **Whitelist origin'ов.** Только `https://gde-code.ru` и `https://www.gde-code.ru`. Чужой → `Access-Control-Allow-Origin: https://gde-code.ru` (браузер заблокирует).
5. **JWT 90 дней с возможностью отзыва.** Сессия идентифицируется `sid` в payload и записью в `auth_sessions`. `logout-all` ставит `revoked_at`.
6. **Тесты вместе с кодом, не «потом».** `npm test` в этом пакете должен быть зелёным перед каждым коммитом.

## Структура

```
private-api/
├── package.json
├── .env.example
├── README.md (этот файл)
├── handlers/
│   └── health.js              ← GET /health (Bearer)
├── lib/
│   ├── db.js                  ← pg.Pool singleton + тестовые хуки
│   ├── cors.js                ← whitelist + GET/POST/PATCH/DELETE
│   ├── response.js            ← ok/badRequest/.../tooManyRequests/serverError
│   ├── mask-pii.js            ← maskPhone / maskEmail / maskToken
│   ├── jwt.js                 ← signJwt / verifyJwt (заглушка → 6.3)
│   ├── auth.js                ← extractBearerToken / requireUser (заглушка → 6.3)
│   ├── sms-provider.js        ← sendOtpSms (мок до подключения SMS.ru)
│   └── email-provider.js      ← sendEmailVerify / sendMagicLink (мок до Yandex Postbox)
└── test/
    └── lib.test.js            ← unit-тесты каркаса (cors, response, mask-pii, mocks, health)
```

## Локально

```bash
cd private-api
npm install
npm test          # node --test, инфраструктурные тесты; PG не нужен (моки)
```

Из корня репо: `npm test` гоняет тесты обоих пакетов (public-api + private-api).

## Внешние провайдеры (мок-режим)

| Провайдер | Что | Когда подключим |
|---|---|---|
| **SMS.ru** | OTP-код при регистрации и при входе с нового устройства без email | После получения API ID и согласования договора |
| **Yandex Postbox** | Письма подтверждения email и magic link для входа | После верификации `gde-code.ru` (SPF/DKIM/DMARC) и подтверждения `noreply@gde-code.ru` |
| **CloudPayments** | Оплата подписки | Этап 7 |
| **X-Parser-Secret** (Azure) | Аутентификация парсер-callback'ов | Этап 6.8, секрет в Lockbox |

В мок-режиме провайдеры не отправляют наружу ничего — только пишут в `console.log` замаскированные метаданные (`maskPhone`, `maskEmail`) и возвращают `{ ok: true, providerId: 'mock', externalId }`. Этого хватает для интеграционных тестов до подключения реальных каналов.

## Деплой

Не делаем — Yandex Cloud пока заблокирован для регистрации. Скрипты `deploy:*` добавим, когда YC разблокируется, по образцу `public-api/`.

## Связь с другими частями проекта

- **`../public-api/`** — read-only API лендинга, тот же кластер PG, схема `public_data`.
- **`../parser/`** — Playwright/AI парсер (этап 8), бьёт в `/api/admin/parser/*` через `X-Parser-Secret`.
- **`../docs/ТЗ_ГдеКод_MVP_v16_FINAL.docx`** — источник правды по контракту эндпоинтов и UX-логике.
- **`../docs/Стратегия_тестирования_ГдеКод_v1.docx`** — обязательные тесты по этапу 6 (см. §24.4).
