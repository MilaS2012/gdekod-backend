// =============================================================================
// db/queries/merchants.js — SQL-запросы по магазинам.
//
// Параметризация ВСЕХ значений через $1, $2 — никогда не склеиваем SQL
// строкой, иначе SQL-injection.
// =============================================================================

import { getPool } from '../client.js';

const MERCHANT_PUBLIC_FIELDS = `
    id,
    name,
    domain,
    category,
    logo_url
`;

export async function listActiveMerchants({ category } = {}) {
    const pool = getPool();
    if (category) {
        const { rows } = await pool.query(
            `SELECT ${MERCHANT_PUBLIC_FIELDS}
             FROM merchants
             WHERE is_active = true AND category = $1
             ORDER BY name`,
            [category],
        );
        return rows;
    }
    const { rows } = await pool.query(
        `SELECT ${MERCHANT_PUBLIC_FIELDS}
         FROM merchants
         WHERE is_active = true
         ORDER BY name`,
    );
    return rows;
}

export async function getMerchantById(id) {
    const pool = getPool();
    const { rows } = await pool.query(
        `SELECT ${MERCHANT_PUBLIC_FIELDS}
         FROM merchants
         WHERE id = $1 AND is_active = true`,
        [id],
    );
    return rows[0] ?? null;
}
