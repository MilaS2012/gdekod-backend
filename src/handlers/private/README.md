# Приватный API (план)

Здесь будут handler'ы для эндпоинтов, требующих авторизации пользователя. Сейчас директория-заглушка — вернёмся к ней после стабилизации публичного API и подключения провайдера авторизации.

## Планируемые домены

| Домен | Эндпоинты | Что делает |
|---|---|---|
| `auth/` | `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh` | Вход / выход / обновление сессии. Скорее всего на JWT с refresh-токеном в httpOnly-cookie. |
| `subscription/` | `GET /subscription`, `POST /subscription/start`, `POST /subscription/cancel` | Pro-подписка: статус, оформление через ЮKassa / CloudPayments, отмена. |
| `account/` | `GET /account`, `PATCH /account`, `DELETE /account` | Профиль пользователя: имя, e-mail, удаление аккаунта (152-ФЗ — право на забвение). |
| `support/` | `POST /support/tickets`, `GET /support/tickets/{id}` | Обращения в поддержку. Запись в БД + уведомление операторам (тг-бот / email). |

## Ключевые решения, ещё не принятые

- **Auth-провайдер.** Свой JWT vs. Yandex ID OAuth vs. внешний (Auth0/Clerk — не подходят из-за санкций и платёжек). Вероятно — свой минимальный JWT с argon2 для паролей.
- **Сессии.** Серверные сессии в Redis (Yandex Managed Redis) или stateless JWT. Stateless проще для serverless.
- **Хранение пользователей.** Отдельная таблица `users` в той же PG-БД или отдельная инстанция? — Скорее всего та же, но с RLS / права через отдельного PG-пользователя.
- **Платежи.** ЮKassa или CloudPayments. От выбора зависит модуль `subscription/`.

## Принципы (общие с публичным API)

- Stack trace не уходит клиенту — только `requestId` для саппорта.
- `console.error` как единственный способ логирования ошибок (попадает в YC Logging автоматически).
- PG-pool через global scope (`db/client.js`) — переиспользуется на warm starts.
- CORS — те же два origin'а: `https://gde-code.ru`, `https://www.gde-code.ru`.

## Чего здесь точно НЕ будет

- Админская панель и операционные эндпоинты — отдельный backend, отдельный кластер функций, отдельный домен (`admin.gde-code.ru`). Чтобы скомпрометированный публичный API не мог дёрнуть админские ручки.
- Долгие фоновые задачи (автопроверка промокодов, рассылки) — это Yandex Cloud Triggers + отдельные функции, не handler'ы запросов.
