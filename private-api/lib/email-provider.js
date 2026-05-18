// =============================================================================
// email-provider.js — отправка email (мок до верификации Yandex Postbox).
//
// ★ ПОКА МОК. Реальный Yandex Postbox подключим после:
//   - Регистрации Postbox в Yandex Cloud
//   - Верификации домена gde-code.ru (SPF/DKIM/DMARC через Cloudflare DNS)
//   - Подтверждения адреса noreply@gde-code.ru
//   - Настройки лимитов (старт: 100 писем/час, см. ТЗ §3.7.1)
//
// Поведение мока:
//   - В логи пишем только замаскированный получатель и тему. Сами текст
//     письма и токен в логи НЕ попадают (токен — это half-credential).
//   - Возвращаем { ok: true, providerId: 'mock', externalId: '<uuid>' }.
//
// Реальный Yandex Postbox: SMTP-relay на smtp.postbox.yandexcloud.net:587
// (STARTTLS) с SMTP-логином/паролем из YANDEX_POSTBOX_SMTP_*.
//
// Контракт:
//   sendEmailVerify({ to, link })       → Promise<{ ok, providerId, externalId }>
//   sendMagicLink({ to, link, phoneMask }) → Promise<{ ok, providerId, externalId }>
// =============================================================================

import { randomUUID } from 'node:crypto';
import { maskEmail } from './mask-pii.js';

const PROVIDER_MOCK = 'mock';
// const PROVIDER_POSTBOX = 'yandex_postbox';

/**
 * Письмо подтверждения email-адреса. Шаблон — §3.7.6.
 */
export async function sendEmailVerify({ to, link }) {
    assertEmail(to);
    assertLink(link);
    const subject = 'Подтверди email для аккаунта ГдеКод';
    return sendInternal({ to, subject, kind: 'email_verify' });
}

/**
 * Письмо для входа по magic link. Шаблон — §3.7.10.
 * phoneMask — это уже замаскированный номер (например, '+7 *** *** ** 67'),
 * показывается в письме «Кто-то пытается войти с номера ...».
 */
export async function sendMagicLink({ to, link, phoneMask }) {
    assertEmail(to);
    assertLink(link);
    if (typeof phoneMask !== 'string' || phoneMask.length === 0) {
        throw new Error('email-provider: phoneMask required for magic link');
    }
    const subject = 'Вход в ГдеКод';
    return sendInternal({ to, subject, kind: 'magic_link' });
}

function sendInternal({ to, subject, kind }) {
    if (!process.env.YANDEX_POSTBOX_SMTP_HOST) {
        return sendMock({ to, subject, kind });
    }
    // TODO(после верификации домена): SMTP-relay через Yandex Postbox
    return sendMock({ to, subject, kind });
}

function sendMock({ to, subject, kind }) {
    const externalId = randomUUID();
    console.log('[email mock] sent', {
        to: maskEmail(to),
        subject,
        kind,
        externalId,
    });
    return Promise.resolve({ ok: true, providerId: PROVIDER_MOCK, externalId });
}

function assertEmail(email) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('email-provider: invalid email');
    }
    if (email.length > 254) {
        throw new Error('email-provider: email too long');
    }
}

function assertLink(link) {
    if (typeof link !== 'string' || !/^https:\/\//.test(link)) {
        throw new Error('email-provider: link must be https://');
    }
}
