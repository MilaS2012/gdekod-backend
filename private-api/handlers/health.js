// =============================================================================
// GET /health  (Bearer-protected, не публичный)
//
// Используется внешним мониторингом. Защищён Bearer-токеном из env
// PRIVATE_API_HEALTH_TOKEN (приходит из Yandex Lockbox). Без токена в env
// endpoint падает с 500 — намеренно, чтобы health случайно не стал
// публичным из-за пропущенной переменной.
//
// ★ Этот Bearer — НЕ JWT пользователя. Это отдельный shared-secret
//   для UptimeRobot / Yandex Monitoring.
// =============================================================================

import { getPool } from '../lib/db.js';
import { ok, unauthorized, serverError } from '../lib/response.js';

export async function handler(event, context) {
    const requestId = context?.requestId ?? null;

    const expected = process.env.PRIVATE_API_HEALTH_TOKEN || '';
    if (!expected) {
        console.error('[health] PRIVATE_API_HEALTH_TOKEN не задан — endpoint заблокирован');
        return serverError({ requestId });
    }

    const auth = event?.headers?.authorization ?? event?.headers?.Authorization ?? '';
    if (auth !== `Bearer ${expected}`) {
        return unauthorized();
    }

    try {
        const res = await getPool().query('SELECT 1 AS ok');
        const dbOk = res?.rows?.[0]?.ok === 1;
        return ok({
            status:  dbOk ? 'ok' : 'degraded',
            service: 'private',
            version: process.env.GIT_SHA ?? 'dev',
            db:      dbOk,
            time:    new Date().toISOString(),
        });
    } catch (err) {
        console.error('[health]', { requestId, message: err?.message });
        return serverError({ requestId });
    }
}
