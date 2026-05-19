// =============================================================================
// POST /api/account/export
//
// Авторизованный. Собирает все данные user'а в JSON и отдаёт как
// downloadable файл (Content-Disposition: attachment). По 152-ФЗ ст. 14
// (право на портативность) и ТЗ v16.1 §19.3.
//
// ★ В экспорте — ПОЛНЫЕ данные (не маскированные). Юзер имеет на них право.
//   Это единственный handler, где мы возвращаем phone/email открытым текстом.
//
// ★ Rate-limit: 1 экспорт в час через events_log (event_type='data_exported').
//   Минимизация копий ПД и защита от DoS (экспорт — тяжёлая операция,
//   несколько SELECT'ов + большой response).
//
// ★ Лог — БЕЗ содержимого. Только user_id и факт экспорта. JSON содержит
//   много ПД, в Cloud Logging он не должен попасть.
// =============================================================================

import { getPool } from '../../lib/db.js';
import { requireUser, AuthError } from '../../lib/auth.js';
import {
    ok, methodNotAllowed, tooManyRequests, unauthorized, serverError,
    corsPreflight, getOrigin, toIso,
} from '../../lib/response.js';
import { EXPORT_RATE_LIMIT_PER_HOUR } from '../../lib/account-deletion-config.js';

const HOUR_MS = 60 * 60 * 1000;
const EXPORT_FORMAT_VERSION = '1.0';

export async function handler(event, context, deps = {}) {
    const origin    = getOrigin(event);
    const requestId = context?.requestId ?? null;
    const pool      = deps.pool ?? getPool();

    const method = event?.httpMethod;
    if (method === 'OPTIONS')        return corsPreflight(origin);
    if (method && method !== 'POST') return methodNotAllowed(['POST', 'OPTIONS'], { origin });

    let userId = null;
    try {
        let auth;
        try { auth = await requireUser(event, { pool }); }
        catch (e) {
            if (e instanceof AuthError) return unauthorized('unauthorized', { origin });
            throw e;
        }
        userId = auth.user_id;

        // ─── Rate-limit ─────────────────────────────────────────────────────
        // events_log хранит события 180 дней (events-cleanup), так что
        // окно «1 раз в час» точно влезет.
        const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
        const recent = (await pool.query(
            `SELECT created_at
               FROM private_data.events_log
              WHERE user_id = $1
                AND event_type = 'data_exported'
                AND created_at > $2
              LIMIT $3`,
            [userId, hourAgo, EXPORT_RATE_LIMIT_PER_HOUR],
        )).rows;
        if (recent.length >= EXPORT_RATE_LIMIT_PER_HOUR) {
            console.warn('[account.export.rate_limited]', {
                request_id: requestId, user_id: userId,
            });
            return tooManyRequests({
                error: 'too_many_exports',
                message: 'Экспорт можно выполнять не чаще 1 раза в час.',
            }, { origin });
        }

        // ─── Сбор данных ────────────────────────────────────────────────────
        // Параллельные SELECT'ы — независимы, выигрываем round-trip.
        const [
            profileRow,
            subscriptionRows,
            receiptRows,
            revealRows,
            voteRows,
            sessionRows,
            ticketRows,
        ] = await Promise.all([
            pool.query(
                `SELECT id, phone, display_name, email, email_verified_at,
                        phone_verified_at, profile_updated_at, created_at
                   FROM private_data.users
                  WHERE id = $1`,
                [userId],
            ),
            pool.query(
                `SELECT id, tariff, provider, status, amount_kopecks, currency,
                        created_at, activated_at, cancelled_at, expires_at,
                        next_charge_at
                   FROM private_data.subscriptions
                  WHERE user_id = $1
                  ORDER BY created_at DESC`,
                [userId],
            ),
            pool.query(
                `SELECT id, subscription_id, amount_kopecks, currency, provider,
                        provider_payment_id, is_mock, period_start, period_end,
                        created_at
                   FROM private_data.receipts
                  WHERE user_id = $1
                  ORDER BY created_at DESC`,
                [userId],
            ),
            pool.query(
                `SELECT cr.id, cr.coupon_id, cr.revealed_at,
                        c.code, c.description, c.discount
                   FROM private_data.coupon_reveals cr
                   LEFT JOIN public_data.coupons c ON c.id = cr.coupon_id
                  WHERE cr.user_id = $1
                  ORDER BY cr.revealed_at DESC`,
                [userId],
            ),
            pool.query(
                `SELECT id, coupon_id, vote_type, created_at
                   FROM private_data.coupon_votes
                  WHERE user_id = $1
                  ORDER BY created_at DESC`,
                [userId],
            ),
            pool.query(
                `SELECT session_id, created_at, last_used_at, expires_at,
                        ip_address::text AS ip_address, user_agent_summary
                   FROM private_data.auth_sessions
                  WHERE user_id = $1
                    AND revoked_at IS NULL
                    AND expires_at > now()
                  ORDER BY created_at DESC`,
                [userId],
            ),
            pool.query(
                `SELECT id, category, subject, message, status,
                        created_at, updated_at, closed_at,
                        contact_phone, contact_email
                   FROM private_data.support_tickets
                  WHERE user_id = $1
                  ORDER BY created_at DESC`,
                [userId],
            ),
        ]);

        const profile = profileRow.rows[0];
        if (!profile) {
            // Не должно случаться: requireUser уже проверил сессию.
            console.error('[account.export.anomaly]', {
                request_id: requestId, user_id: userId, reason: 'user_missing',
            });
            return serverError({ origin, requestId });
        }

        // ─── Маппинг ────────────────────────────────────────────────────────
        const exportData = {
            export_format_version: EXPORT_FORMAT_VERSION,
            exported_at:           new Date().toISOString(),

            profile: {
                id:                  profile.id,
                phone:               profile.phone,
                display_name:        profile.display_name,
                email:               profile.email,
                email_verified_at:   toIso(profile.email_verified_at),
                phone_verified_at:   toIso(profile.phone_verified_at),
                profile_updated_at:  toIso(profile.profile_updated_at),
                registered_at:       toIso(profile.created_at),
            },
            subscriptions: subscriptionRows.rows.map(r => ({
                id:              r.id,
                tariff:          r.tariff,
                provider:        r.provider,
                status:          r.status,
                amount_kopecks:  r.amount_kopecks,
                currency:        r.currency,
                created_at:      toIso(r.created_at),
                activated_at:    toIso(r.activated_at),
                cancelled_at:    toIso(r.cancelled_at),
                expires_at:      toIso(r.expires_at),
                next_charge_at:  toIso(r.next_charge_at),
            })),
            receipts: receiptRows.rows.map(r => ({
                id:                   r.id,
                subscription_id:      r.subscription_id,
                amount_kopecks:       r.amount_kopecks,
                currency:             r.currency,
                provider:             r.provider,
                provider_payment_id:  r.provider_payment_id,
                is_mock:              r.is_mock,
                period_start:         toIso(r.period_start),
                period_end:           toIso(r.period_end),
                created_at:           toIso(r.created_at),
            })),
            coupons_revealed: revealRows.rows.map(r => ({
                id:           r.id,
                revealed_at:  toIso(r.revealed_at),
                coupon_id:    r.coupon_id,
                code:         r.code,
                description:  r.description,
                discount:     r.discount,
            })),
            votes: voteRows.rows.map(r => ({
                id:         r.id,
                coupon_id:  r.coupon_id,
                vote_type:  r.vote_type,
                created_at: toIso(r.created_at),
            })),
            active_sessions: sessionRows.rows.map(r => ({
                session_id:          r.session_id,
                created_at:          toIso(r.created_at),
                last_used_at:        toIso(r.last_used_at),
                expires_at:          toIso(r.expires_at),
                ip_address:          r.ip_address,
                user_agent_summary:  r.user_agent_summary,
            })),
            support_tickets: ticketRows.rows.map(r => ({
                id:             r.id,
                category:       r.category,
                subject:        r.subject,
                message:        r.message,
                status:         r.status,
                created_at:     toIso(r.created_at),
                updated_at:     toIso(r.updated_at),
                closed_at:      toIso(r.closed_at),
                contact_phone:  r.contact_phone,
                contact_email:  r.contact_email,
            })),
        };

        // ─── Запись в events_log (rate-limit использует эту запись) ─────────
        await pool.query(
            `INSERT INTO private_data.events_log (user_id, event_type)
             VALUES ($1, 'data_exported')`,
            [userId],
        );

        console.log('[account.exported]', {
            request_id: requestId, user_id: userId,
            subscriptions:   exportData.subscriptions.length,
            receipts:        exportData.receipts.length,
            coupons_revealed: exportData.coupons_revealed.length,
            votes:           exportData.votes.length,
            active_sessions: exportData.active_sessions.length,
            support_tickets: exportData.support_tickets.length,
        });

        const filename = `gdekod-data-${formatDateYYYYMMDD(new Date())}.json`;
        return ok(exportData, {
            origin,
            headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
        });
    } catch (err) {
        console.error('[account.export]', {
            request_id: requestId, user_id: userId, message: err?.message,
        });
        return serverError({ origin, requestId });
    }
}

function formatDateYYYYMMDD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}
