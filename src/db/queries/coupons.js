// =============================================================================
// db/queries/coupons.js — SQL-запросы по промокодам.
//
// Возвращаем только status='active' для публичного API. Истекшие, removed
// и needs_manual_check скрываем — это внутренние состояния.
// =============================================================================

import { getPool } from '../client.js';

const COUPON_PUBLIC_FIELDS = `
    id,
    merchant_id,
    code,
    discount,
    description,
    expires_at,
    verified_text
`;

export async function listActiveCoupons({ merchantId } = {}) {
    const pool = getPool();
    if (merchantId) {
        const { rows } = await pool.query(
            `SELECT ${COUPON_PUBLIC_FIELDS}
             FROM coupons
             WHERE status = 'active' AND merchant_id = $1
             ORDER BY created_at DESC`,
            [merchantId],
        );
        return rows;
    }
    const { rows } = await pool.query(
        `SELECT ${COUPON_PUBLIC_FIELDS}
         FROM coupons
         WHERE status = 'active'
         ORDER BY created_at DESC`,
    );
    return rows;
}

export async function getCouponById(id) {
    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT ${COUPON_PUBLIC_FIELDS}
         FROM coupons
         WHERE id = $1 AND status = 'active'`,
        [id],
    );
    return rows[0] ?? null;
}
