// =============================================================================
// POST /api/support/tickets
//
// Авторизованный. Создаёт новое обращение в поддержку.
//
// Валидация:
//   - category ∈ TICKET_CATEGORIES (см. lib/support-config.js,
//     синхронизировано с CHECK constraint миграции 013)
//   - subject  — trim, 1..200, без управляющих символов
//   - message  — trim, 10..5000
//
// Контактные данные — СНЭПШОТ users.phone / users.email (если verified)
// на момент создания. Дальше user может сменить email — в этом тикете
// останется тот, на который реально пойдёт ответ.
//
// Rate-limit (анти-спам):
//   - не больше TICKETS_PER_HOUR за последний час
//   - не больше TICKETS_PER_DAY за последние 24 часа
//
// ★ НЕ логируем содержимое subject/message — это ПД и приватный текст.
//   В лог уходят только длины и факт создания.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    badRequest, created, methodNotAllowed, tooManyRequests, unauthorized,
    serverError, corsPreflight, parseJsonBody, getOrigin, toIso,
} from '../../lib/response.js';
import { TICKET_CATEGORIES, TICKET_LIMITS } from '../../lib/support-config.js';
import { maskEmail } from '../../lib/mask-pii.js';

// Запрещаем управляющие символы в subject (как в display_name).
const CTRL_RE = /[\x00-\x1F\x7F]/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    let category = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        const body = parseJsonBody(event);
        if (body == null) return badRequest('invalid_input', { origin });

        // category
        category = typeof body.category === 'string' ? body.category : null;
        if (!category || !TICKET_CATEGORIES.includes(category)) {
            return badRequest('invalid_category', { origin });
        }

        // subject
        const subjectRaw = typeof body.subject === 'string' ? body.subject : null;
        if (subjectRaw == null) return badRequest('invalid_subject', { origin });
        const subject = subjectRaw.trim();
        if (subject.length === 0
            || subject.length > TICKET_LIMITS.SUBJECT_MAX_LENGTH
            || CTRL_RE.test(subject)) {
            return badRequest('invalid_subject', { origin });
        }

        // message
        const messageRaw = typeof body.message === 'string' ? body.message : null;
        if (messageRaw == null) return badRequest('invalid_message_length', { origin });
        const message = messageRaw.trim();
        if (message.length < TICKET_LIMITS.MESSAGE_MIN_LENGTH
            || message.length > TICKET_LIMITS.MESSAGE_MAX_LENGTH) {
            return badRequest('invalid_message_length', { origin });
        }

        // ─── Rate-limit ──────────────────────────────────────────────────────
        // Hour сначала: более жёсткий лимит, обычно срабатывает раньше
        // (если user шлёт залпом). Day — медленный фон.
        const hourCutoff = new Date(Date.now() - HOUR_MS);
        const dayCutoff  = new Date(Date.now() - DAY_MS);

        const hourCount = (await pool.query(
            `SELECT count(*)::int AS c
               FROM private_data.support_tickets
              WHERE user_id = $1 AND created_at > $2`,
            [userId, hourCutoff.toISOString()],
        )).rows[0].c;
        if (hourCount >= TICKET_LIMITS.TICKETS_PER_HOUR) {
            console.warn('[support.ticket_rate_limit]', {
                request_id: requestId, user_id: userId, window: 'hour',
                count: hourCount, limit: TICKET_LIMITS.TICKETS_PER_HOUR,
            });
            return tooManyRequests({
                error: 'too_many_tickets',
                message: 'Лимит создания обращений превышен. Попробуйте позже.',
                window: 'hour',
            }, { origin });
        }

        const dayCount = (await pool.query(
            `SELECT count(*)::int AS c
               FROM private_data.support_tickets
              WHERE user_id = $1 AND created_at > $2`,
            [userId, dayCutoff.toISOString()],
        )).rows[0].c;
        if (dayCount >= TICKET_LIMITS.TICKETS_PER_DAY) {
            console.warn('[support.ticket_rate_limit]', {
                request_id: requestId, user_id: userId, window: 'day',
                count: dayCount, limit: TICKET_LIMITS.TICKETS_PER_DAY,
            });
            return tooManyRequests({
                error: 'too_many_tickets',
                message: 'Лимит создания обращений превышен. Попробуйте завтра.',
                window: 'day',
            }, { origin });
        }

        // ─── Snapshot контактных данных ──────────────────────────────────────
        const userRow = (await pool.query(
            `SELECT phone, email, email_verified_at
               FROM private_data.users
              WHERE id = $1`,
            [userId],
        )).rows[0];
        if (!userRow) {
            // Не должно случаться: requireUser уже проверил сессию по user_id.
            console.error('[support.tickets_create.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }
        const contactPhone = userRow.phone;
        const contactEmail = userRow.email_verified_at != null ? userRow.email : null;

        // ─── INSERT ──────────────────────────────────────────────────────────
        const row = (await pool.query(
            `INSERT INTO private_data.support_tickets
               (user_id, category, subject, message, contact_phone, contact_email)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [userId, category, subject, message, contactPhone, contactEmail],
        )).rows[0];

        // Лог без содержимого — только метаданные.
        console.log('[support.ticket_created]', {
            request_id:     requestId,
            user_id:        userId,
            ticket_id:      row.id,
            category,
            subject_length: subject.length,
            message_length: message.length,
            contact_email:  contactEmail != null,   // boolean, не сам email
        });

        const replyHint = contactEmail != null
            ? `Ответ придёт на ${maskEmail(contactEmail)}`
            : 'Ответ придёт на указанный телефон';

        return created({
            ticket_id:  row.id,
            created_at: toIso(row.created_at),
            message:    `Обращение создано. ${replyHint}.`,
        }, { origin });
    } catch (err) {
        console.error('[support.tickets_create]', {
            request_id: requestId, user_id: userId, category,
            message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}
