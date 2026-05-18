// =============================================================================
// billing-config.test.js — lib/billing-config.js (6.6).
//
// assertNoMockInProduction вызывается при импорте модуля. Импорт делается
// один раз при загрузке этого test-файла — NODE_ENV в этот момент 'test'
// (или undefined), MOCK_OPERATOR_BILLING обычно не задан. Импорт проходит.
//
// Дальше тесты меняют env и вызывают функцию НАПРЯМУЮ (она читает env
// каждый раз заново). Для тестов getAvailableProviders то же самое —
// функция читает NODE_ENV каждый вызов.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TARIFFS,
    getAvailableProviders,
    isProviderAllowedForTariff,
    assertNoMockInProduction,
} from '../lib/billing-config.js';

const savedNodeEnv = process.env.NODE_ENV;
const savedMock    = process.env.MOCK_OPERATOR_BILLING;

function setEnv(node_env, mock) {
    if (node_env === undefined) delete process.env.NODE_ENV;
    else                         process.env.NODE_ENV = node_env;
    if (mock === undefined)      delete process.env.MOCK_OPERATOR_BILLING;
    else                         process.env.MOCK_OPERATOR_BILLING = mock;
}
function restoreEnv() {
    setEnv(savedNodeEnv, savedMock);
}

// -----------------------------------------------------------------------------
// TARIFFS
// -----------------------------------------------------------------------------

test('TARIFFS: daily_35 = 3500 копеек, period 1 день', () => {
    assert.equal(TARIFFS.daily_35.amount_kopecks, 3500);
    assert.equal(TARIFFS.daily_35.period_seconds, 86_400);
    assert.equal(TARIFFS.daily_35.display_name,   '35 ₽/сутки');
});

test('TARIFFS: monthly_499 = 49900 копеек, period 30 дней', () => {
    assert.equal(TARIFFS.monthly_499.amount_kopecks, 49_900);
    assert.equal(TARIFFS.monthly_499.period_seconds, 2_592_000);
});

test('TARIFFS: frozen — нельзя мутировать', () => {
    assert.throws(() => { TARIFFS.daily_35.amount_kopecks = 9999; }, TypeError);
});

// -----------------------------------------------------------------------------
// getAvailableProviders
// -----------------------------------------------------------------------------

test('6: getAvailableProviders("daily_35") в staging → только operator_mock', () => {
    setEnv('staging', undefined);
    const providers = getAvailableProviders('daily_35');
    assert.deepEqual([...providers], ['operator_mock']);
    restoreEnv();
});

test('7: getAvailableProviders("daily_35") в production → реальные операторы', () => {
    setEnv('production', undefined);
    const providers = getAvailableProviders('daily_35');
    assert.deepEqual([...providers], ['operator_megafon', 'operator_t2', 'operator_beeline']);
    restoreEnv();
});

test('8: getAvailableProviders("monthly_499") одинаков в обоих env', () => {
    setEnv('staging', undefined);
    const staging = [...getAvailableProviders('monthly_499')];
    setEnv('production', undefined);
    const prod    = [...getAvailableProviders('monthly_499')];
    assert.deepEqual(staging, prod);
    assert.deepEqual(staging, ['cloudpayments_card', 'cloudpayments_sbp']);
    restoreEnv();
});

test('getAvailableProviders("unknown_tariff") → []', () => {
    assert.deepEqual([...getAvailableProviders('unknown')], []);
});

// -----------------------------------------------------------------------------
// isProviderAllowedForTariff
// -----------------------------------------------------------------------------

test('isProviderAllowedForTariff: daily_35 + operator_mock на staging → true', () => {
    setEnv('staging', undefined);
    assert.equal(isProviderAllowedForTariff('daily_35', 'operator_mock'), true);
    restoreEnv();
});

test('isProviderAllowedForTariff: daily_35 + cloudpayments → false везде', () => {
    setEnv('staging', undefined);
    assert.equal(isProviderAllowedForTariff('daily_35', 'cloudpayments_card'), false);
    setEnv('production', undefined);
    assert.equal(isProviderAllowedForTariff('daily_35', 'cloudpayments_card'), false);
    restoreEnv();
});

test('isProviderAllowedForTariff: monthly_499 + operator_mock → false везде', () => {
    setEnv('staging', undefined);
    assert.equal(isProviderAllowedForTariff('monthly_499', 'operator_mock'), false);
    restoreEnv();
});

test('isProviderAllowedForTariff: daily_35 + operator_megafon на staging → false (в staging только mock)', () => {
    setEnv('staging', undefined);
    assert.equal(isProviderAllowedForTariff('daily_35', 'operator_megafon'), false);
    restoreEnv();
});

// -----------------------------------------------------------------------------
// assertNoMockInProduction
// -----------------------------------------------------------------------------

test('9: assertNoMockInProduction в production + MOCK=true → throws', () => {
    setEnv('production', 'true');
    assert.throws(
        () => assertNoMockInProduction(),
        /CRITICAL.*MOCK_OPERATOR_BILLING.*production/,
    );
    restoreEnv();
});

test('10: assertNoMockInProduction в staging + MOCK=true → OK', () => {
    setEnv('staging', 'true');
    assert.doesNotThrow(() => assertNoMockInProduction());
    restoreEnv();
});

test('assertNoMockInProduction в production + MOCK=false → OK', () => {
    setEnv('production', 'false');
    assert.doesNotThrow(() => assertNoMockInProduction());
    restoreEnv();
});
