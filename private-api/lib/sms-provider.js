// =============================================================================
// sms-provider.js — отправка SMS / Flash Call / Voice (мок до подключения SMS.ru).
//
// ★ ПОКА МОК. Реальный SMS.ru подключим после согласования договора.
//
// channel определяет:
//   - 'sms':         текстовое SMS с кодом + условия рекуррентной подписки
//                    (по требованию платёжных систем РФ для оформления
//                    рекурента нужно явное текстовое согласие).
//                    Шаблон: «Код NNNN. Вводя его, вы регистрируетесь на ГдеКод
//                    и активируете подписку 35₽/сутки. Условия: gde-code.ru/oferta»
//   - 'flash_call':  короткий звонок, последние 4 цифры номера = код.
//                    Текст не передаётся (звонок сбрасывается).
//   - 'voice':       робот зачитывает код голосом (резерв на будущее).
//
// Поведение мока:
//   - В логи пишем только замаскированный номер, channel и длину кода.
//     САМ КОД и ПОЛНЫЙ ТЕКСТ в логи НЕ попадают никогда (ТЗ §3.6, §21).
//   - Возвращаем { ok: true, providerId: 'mock', externalId: '<uuid>' }.
//
// Контракт:
//   sendOtpSms({ phone, code, channel }) → Promise<{ ok, providerId, externalId }>
// =============================================================================

import { randomUUID } from 'node:crypto';
import { maskPhone } from './mask-pii.js';

const PROVIDER_MOCK = 'mock';
const ALLOWED_CHANNELS = new Set(['sms', 'flash_call', 'voice']);

export async function sendOtpSms({ phone, code, channel }) {
    assertPhone(phone);
    assertOtpCode(code);
    assertChannel(channel);

    if (!process.env.SMS_RU_API_ID) {
        return sendMock({ phone, code, channel });
    }
    // TODO(после получения ключей): реальная отправка через SMS.ru.
    // Шаблоны:
    //   sms        → "Код NNNN. Вводя его, вы регистрируетесь на ГдеКод
    //                 и активируете подписку 35₽/сутки. Условия: gde-code.ru/oferta"
    //   flash_call → провайдер инициирует короткий звонок с номера,
    //                 заканчивающегося на code
    //   voice      → робот зачитывает code голосом
    return sendMock({ phone, code, channel });
}

function sendMock({ phone, code, channel }) {
    const externalId = randomUUID();
    console.log('[sms mock]', {
        kind:        channel,
        phone:       maskPhone(phone),
        code_length: code.length,
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

function assertChannel(channel) {
    if (!ALLOWED_CHANNELS.has(channel)) {
        throw new Error(`sms-provider: channel must be one of ${[...ALLOWED_CHANNELS].join(', ')}`);
    }
}
