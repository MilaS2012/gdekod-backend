// =============================================================================
// tokens.js — генерация одноразовых сessионных токенов (magic link, email verify).
//
// Технически оба типа токенов идентичны: 32 случайных байта в base64url
// (~43 символа). Семантика (для чего токен) определяется тем, в какую
// таблицу он попадает (magic_link_tokens / email_verify_tokens), не
// именем генератора.
//
// VARCHAR(64) в обеих таблицах — с запасом. Срок жизни / одноразовость
// обеспечиваются полями expires_at / used_at в БД.
// =============================================================================

import { randomBytes } from 'node:crypto';

/**
 * @param {number} [bytes=32] — количество случайных байт.
 *   32 = 256 бит энтропии = неперебираемо в обычных условиях.
 * @returns {string} base64url, без `=` padding.
 */
export function generateRandomToken(bytes = 32) {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
        throw new Error('generateRandomToken: bytes must be 16..64');
    }
    return randomBytes(bytes).toString('base64url');
}
