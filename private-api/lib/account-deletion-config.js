// =============================================================================
// account-deletion-config.js — параметры soft-delete (ТЗ v16.1 §19.3).
//
// Grace period 24 часа — окно, в которое юзер может отменить удаление через
// POST /api/account/cancel-deletion. Прописано в 152-ФЗ ст. 14 («право на
// возражение»). Чем короче окно, тем хуже UX; чем длиннее — тем больше
// технического долга «зомби-аккаунтов».
//
// DELETION_OTP_* — параметры одноразового кода для подтверждения удаления.
// Длина 6 — sms (полный код, не flash_call). TTL 5 минут — как у login OTP.
// MAX_ATTEMPTS 5 — та же защита от brute-force, что в /auth/verify.
//
// Rate-limits:
//   - EXPORT_RATE_LIMIT_PER_HOUR=1 — экспорт всех данных юзера должен быть
//     редкой операцией (минимизация копий ПД, защита от DoS).
//   - DELETION_REQUEST_RATE_LIMIT_PER_HOUR=1 — нельзя дёргать SMS на удаление
//     чаще раза в час (доп. к общему smsRateCheck).
//
// CLEANUP_BATCH_SIZE=100 — сколько user'ов берёт за один тик cron.
// Возможность держать пакет небольшим важна для responsiveness Cloud Function.
// =============================================================================

export const DELETION_GRACE_PERIOD_HOURS = 24;

export const DELETION_OTP_TTL_SECONDS     = 5 * 60;
export const DELETION_OTP_LENGTH          = 6;
export const DELETION_OTP_MAX_ATTEMPTS    = 5;

export const EXPORT_RATE_LIMIT_PER_HOUR              = 1;
export const DELETION_REQUEST_RATE_LIMIT_PER_HOUR    = 1;

export const CLEANUP_BATCH_SIZE = 100;
