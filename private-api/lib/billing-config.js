// =============================================================================
// billing-config.js — конфигурация тарифов, провайдеров и защита от попадания
// mock-оператора в production. ТЗ v16.1 §3.3.1, §3.3.2.
//
// ★ Функции читают process.env при каждом вызове — это правильно для
//   serverless (env могут поменяться при пересоздании контейнера) и
//   нужно для тестов (которые динамически меняют NODE_ENV).
//
// ★ Защита fail-fast: при импорте модуля сразу проверяется текущий env,
//   и если он production + MOCK_OPERATOR_BILLING=true → throw. То есть
//   деплой mock-оператора в production невозможен — функция не загрузится.
// =============================================================================

export const TARIFFS = Object.freeze({
    daily_35: Object.freeze({
        amount_kopecks: 3500,
        period_seconds: 86_400,       // 1 день
        display_name:   '35 ₽/сутки',
    }),
    monthly_499: Object.freeze({
        amount_kopecks: 49_900,
        period_seconds: 2_592_000,    // 30 дней
        display_name:   '499 ₽/месяц',
    }),
});

// Провайдеры по тарифу × env. На staging для daily_35 доступен только
// operator_mock (нет договоров с операторами). На production operator_mock
// запрещён CHECK constraint'ом и assert'ом.
export const PROVIDER_BY_TARIFF = Object.freeze({
    daily_35: Object.freeze({
        production: Object.freeze(['operator_megafon', 'operator_t2', 'operator_beeline']),
        staging:    Object.freeze(['operator_mock']),
    }),
    monthly_499: Object.freeze({
        production: Object.freeze(['cloudpayments_card', 'cloudpayments_sbp']),
        staging:    Object.freeze(['cloudpayments_card', 'cloudpayments_sbp']),
    }),
});

/**
 * Возвращает список провайдеров, доступных для тарифа в текущем env.
 * Читает process.env.NODE_ENV каждый вызов.
 */
export function getAvailableProviders(tariff) {
    const env = process.env.NODE_ENV === 'production' ? 'production' : 'staging';
    return PROVIDER_BY_TARIFF[tariff]?.[env] ?? [];
}

/**
 * Проверка комбинации tariff × provider. Дублирует CHECK в БД на уровне
 * приложения, чтобы давать клиенту чистый 400 вместо мутной 500-ошибки
 * из constraint violation.
 */
export function isProviderAllowedForTariff(tariff, provider) {
    return getAvailableProviders(tariff).includes(provider);
}

/**
 * Fail-fast если деплой с mock-оператором случайно ушёл в production.
 * Читает process.env каждый вызов.
 */
export function assertNoMockInProduction() {
    if (process.env.NODE_ENV === 'production' && process.env.MOCK_OPERATOR_BILLING === 'true') {
        throw new Error(
            'CRITICAL: MOCK_OPERATOR_BILLING=true in production. ' +
            'This is a deployment misconfiguration. Aborting.'
        );
    }
}

// Проверяем сразу при импорте — fail fast.
assertNoMockInProduction();
