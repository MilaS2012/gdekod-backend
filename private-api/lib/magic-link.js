// =============================================================================
// magic-link.js — генерация одноразовых токенов для входа по email
//
// Токен — 32 случайных байта в base64url (~43 символа). VARCHAR(64) в
// таблице с запасом. Срок жизни и одноразовость обеспечиваются полями
// expires_at / used_at в magic_link_tokens (см. миграцию 004).
// =============================================================================

import { randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

export function generateMagicLinkToken() {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}
