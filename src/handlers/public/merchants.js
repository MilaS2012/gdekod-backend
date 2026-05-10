// =============================================================================
// handlers/public/merchants.js — Yandex Cloud Function:
//   GET /merchants
//   GET /merchants/{id}
//
// Энтрипоинт для YC: src/handlers/public/merchants.handler
// (см. package.json → scripts.deploy-public:merchants).
// =============================================================================

import { listActiveMerchants, getMerchantById } from '../../db/queries/merchants.js';
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

        // GET /merchants/{id} — id приходит в pathParameters от API Gateway.
        const rawId = event?.pathParameters?.id ?? event?.params?.id ?? null;
        if (rawId !== null && rawId !== undefined && rawId !== '') {
            const id = Number(rawId);
            if (!Number.isInteger(id) || id <= 0) {
                return badRequest('Invalid id', { origin });
            }
            const merchant = await getMerchantById(id);
            if (!merchant) return notFound('Merchant not found', { origin });
            return ok(merchant, { origin });
        }

        // GET /merchants?category=eda — необязательный фильтр.
        const category = event?.queryStringParameters?.category ?? null;
        const merchants = await listActiveMerchants({ category });
        return ok({ merchants }, { origin });

    } catch (err) {
        // Стэк трейс остаётся ТОЛЬКО в YC Logging. Клиент получит
        // serverError без деталей.
        console.error('[merchants handler]', { requestId, err });
        return serverError({ origin, requestId });
    }
};
