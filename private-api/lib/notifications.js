// =============================================================================
// notifications.js — отправка транзакционных уведомлений пользователю.
//
// ★ ЗАГЛУШКА. Реальные провайдеры подключаются в этапе 6.10:
//   - email через Yandex Postbox
//   - SMS через SMS.ru
//
// Сейчас функция:
//   1. Достаёт у пользователя phone, email, email_verified_at
//   2. Выбирает канал по политике §3.6.3 v16.1:
//      - email привязан и verified → email
//      - иначе → SMS
//   3. Логирует факт уведомления с маскированным получателем
//
// kind — символический идентификатор шаблона (см. §3.6.2 v16.1):
//   - 'subscription_activated'  → Шаблон 2 «подписка 35₽/сутки активна»
//   - 'subscription_cancelled'  → Шаблон 4 «подписка отменена, доступ до DD.MM»
//   - 'payment_failed'          → Шаблон 3 «не удалось списать»
//   - 'new_device_login'        → Шаблон 5 «вход с нового устройства»
//
// Возвращает { sent, channel, recipient_mask }.
// =============================================================================

import { getPool } from './db.js';
import { maskPhone, maskEmail } from './mask-pii.js';

const SUPPORTED_KINDS = new Set([
    'subscription_activated',
    'subscription_cancelled',
    'payment_failed',
    'new_device_login',
]);

/**
 * @param {{ user_id: string, kind: string, params?: object, request_id?: string }} input
 * @param {{ pool?: object }} [deps]
 */
export async function notifyTransactional({ user_id, kind, params = {}, request_id = null }, deps = {}) {
    if (!SUPPORTED_KINDS.has(kind)) {
        throw new Error(`notifyTransactional: unknown kind '${kind}'`);
    }
    const pool = deps.pool ?? getPool();

    const user = (await pool.query(
        `SELECT phone, email, email_verified_at
           FROM private_data.users
          WHERE id = $1`,
        [user_id],
    )).rows[0];
    if (!user) {
        return { sent: false, reason: 'user_not_found' };
    }

    const useEmail = user.email != null && user.email_verified_at != null;
    const channel  = useEmail ? 'email' : 'sms';
    const recipient_mask = useEmail ? maskEmail(user.email) : maskPhone(user.phone);

    // ★ Здесь в 6.10 будут реальные вызовы провайдеров. Сейчас — заглушка.
    console.log('[notification.queued]', {
        request_id,
        user_id,
        kind,
        channel,
        recipient_mask,
        // params в лог не пишем целиком — они могут содержать
        // даты/суммы (не PII, но защитный фильтр для будущего).
        params_keys: Object.keys(params),
    });

    return { sent: true, channel, recipient_mask };
}
