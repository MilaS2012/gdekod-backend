// =============================================================================
// sms-provider.js — отправка SMS (мок до получения SMS.ru API ID).
//
// ★ ПОКА МОК. Реальный SMS.ru подключим после согласования договора.
//
// Поведение мока:
//   - В логи пишем только замаскированный номер и длину кода. САМ КОД
//     в логи не попадает никогда — это PII (ТЗ §3.6, §21).
//   - Возвращаем { ok: true, providerId: 'mock', externalId: '<uuid>' }.
//
// Реальный SMS.ru (этап после получения ключей):
//   - Endpoint: https://sms.ru/sms/send
//   - Параметры: api_id, to (без +), msg, json=1
//   - На успех: { status: 'OK', sms: { '<phone>': { status: 'OK', status_code: 100, sms_id: '...' } } }
//   - Ошибки маппим на коды нашего ответа (429 — лимиты у провайдера и т.д.)
//
// Контракт:
//   sendOtpSms({ phone, code }) → Promise<{ ok, providerId, externalId }>
// =============================================================================

import { randomUUID } from 'node:crypto';
import { maskPhone } from './mask-pii.js';

const PROVIDER_MOCK = 'mock';
// const PROVIDER_SMSRU = 'sms_ru';  // (после подключения)

/**
 * Отправляет SMS с одноразовым кодом.
 * Текст шаблона держим простым и неизменным (ФИО-провайдеры считают
 * репутацию по совпадению с заявленным текстом).
 *   «Код для входа в ГдеКод: 123456. Никому не сообщайте.»
 */
export async function sendOtpSms({ phone, code }) {
    assertPhone(phone);
    assertOtpCode(code);

    if (!process.env.SMS_RU_API_ID) {
        return sendMock({ phone, code });
    }

    // TODO(после получения ключей): реальная отправка через SMS.ru
    // Пока — fallback на мок, чтобы случайно не сломаться.
    return sendMock({ phone, code });
}

function sendMock({ phone, code }) {
    const externalId = randomUUID();
    console.log('[sms mock] OTP sent', {
        phone: maskPhone(phone),
        codeLength: code.length,
        externalId,
    });
    return Promise.resolve({ ok: true, providerId: PROVIDER_MOCK, externalId });
}

function assertPhone(phone) {
    if (typeof phone !== 'string' || !/^\+\d{10,15}$/.test(phone)) {
        throw new Error('sms-provider: phone must be E.164 (+...)');
    }
}

function assertOtpCode(code) {
    if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
        throw new Error('sms-provider: code must be 4..8 digits');
    }
}
