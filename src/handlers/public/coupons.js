// =============================================================================
// handlers/public/coupons.js — Yandex Cloud Function:
//   GET /coupons
//   GET /coupons/{id}
//   GET /coupons?merchant_id=N
//
// Энтрипоинт для YC: src/handlers/public/coupons.handler
// =============================================================================

import { listActiveCoupons, getCouponById } from '../../db/queries/coupons.js';
import {
    ok,
    badRequest,
    notFound,
    methodNotAllowed,
    serverError,
    corsPreflightResponse,
} from '../../utils/response.js';

export const handler = async (event, context) => {
    const origin = event?.headers?.origin ?? event?.headers?.Origin ?? null;
    const requestId = context?.requestId ?? null;

    try {
        const method = event?.httpMethod ?? 'GET';

        if (method === 'OPTIONS') {
            return corsPreflightResponse(origin);
        }
        if (method !== 'GET') {
            return methodNotAllowed({ origin });
        }

        // GET /coupons/{id}
        const rawId = event?.pathParameters?.id ?? event?.params?.id ?? null;
        if (rawId !== null && rawId !== undefined && rawId !== '') {
            const id = Number(rawId);
            if (!Number.isInteger(id) || id <= 0) {
                return badRequest('Invalid id', { origin });
            }
            const coupon = await getCouponById(id);
            if (!coupon) return notFound('Coupon not found', { origin });
            return ok(coupon, { origin });
        }

        // GET /coupons?merchant_id=N — фильтр по магазину.
        const rawMerchantId = event?.queryStringParameters?.merchant_id ?? null;
        let merchantId = null;
        if (rawMerchantId !== null && rawMerchantId !== '') {
            const parsed = Number(rawMerchantId);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                return badRequest('Invalid merchant_id', { origin });
            }
            merchantId = parsed;
        }

        const coupons = await listActiveCoupons({ merchantId });
        return ok({ coupons }, { origin });

    } catch (err) {
        console.error('[coupons handler]', { requestId, err });
        return serverError({ origin, requestId });
    }
};
