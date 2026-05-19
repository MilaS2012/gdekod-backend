// =============================================================================
// cloudpayments-lib.test.js — lib/cloudpayments.js (этап 7).
//
// Группа A из спеки. Проверяем:
//   - verifyWebhookHmac (4 теста): валид / невалид / нет secret / разные длины
//   - mapCpStatus       (1 тест):  все 4 known + unknown
//
// ★ Тестовые секреты — заглушки 'test_webhook_secret_xyz', никогда не
//   реальные ключи CloudPayments.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    verifyWebhookHmac,
    mapCpStatus,
    kopecksToRubles,
} from '../lib/cloudpayments.js';

const TEST_SECRET = 'test_webhook_secret_xyz';

/** Локальный helper — генерация HMAC для тестов (повторяет логику prod-кода). */
function makeHmac(rawBody, secret = TEST_SECRET) {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

const savedSecret = process.env.CLOUDPAYMENTS_WEBHOOK_SECRET;
function setSecret(v) {
    if (v == null) delete process.env.CLOUDPAYMENTS_WEBHOOK_SECRET;
    else           process.env.CLOUDPAYMENTS_WEBHOOK_SECRET = v;
}
function restoreSecret() {
    if (savedSecret === undefined) delete process.env.CLOUDPAYMENTS_WEBHOOK_SECRET;
    else                            process.env.CLOUDPAYMENTS_WEBHOOK_SECRET = savedSecret;
}

// =============================================================================
// A — lib/cloudpayments.js
// =============================================================================

test('A1: verifyWebhookHmac — правильный HMAC → true', () => {
    setSecret(TEST_SECRET);
    const body = JSON.stringify({ TransactionId: 12345, Amount: 499 });
    const hmac = makeHmac(body);

    assert.equal(verifyWebhookHmac(body, hmac), true);
    restoreSecret();
});

test('A2: verifyWebhookHmac — неверный HMAC → false', () => {
    setSecret(TEST_SECRET);
    const body = JSON.stringify({ TransactionId: 12345 });
    const wrongHmac = makeHmac(body, 'different_secret');

    assert.equal(verifyWebhookHmac(body, wrongHmac), false);
    restoreSecret();
});

test('A3: verifyWebhookHmac — нет CLOUDPAYMENTS_WEBHOOK_SECRET → throws', () => {
    setSecret(null); // удаляем переменную
    const body = JSON.stringify({});
    const anyHmac = 'anything';

    assert.throws(
        () => verifyWebhookHmac(body, anyHmac),
        /CLOUDPAYMENTS_WEBHOOK_SECRET not set/,
        'должен throw с понятным сообщением, не return false',
    );
    restoreSecret();
});

test('A4: verifyWebhookHmac — разные длины (короткая подпись) → false без timingSafeEqual', () => {
    setSecret(TEST_SECRET);
    const body = JSON.stringify({ TransactionId: 12345 });
    // Правильный HMAC — 44 символа base64. Подделка — 8 символов.
    const tooShort = 'shortone';

    // НЕ должен бросать RangeError из timingSafeEqual — должен вернуть false
    // через проверку a.length !== b.length.
    assert.equal(verifyWebhookHmac(body, tooShort), false);
    restoreSecret();
});

test('A5: mapCpStatus — все 4 known + unknown', () => {
    assert.equal(mapCpStatus('Completed'),  'active');
    assert.equal(mapCpStatus('Authorized'), 'pending');
    assert.equal(mapCpStatus('Declined'),   'failed');
    assert.equal(mapCpStatus('Cancelled'),  'failed');
    assert.equal(mapCpStatus('SomethingNew'), 'unknown');
    assert.equal(mapCpStatus(null),         'unknown');
    assert.equal(mapCpStatus(undefined),    'unknown');

    // Бонус: kopecksToRubles
    assert.equal(kopecksToRubles(49900), 499);
    assert.equal(kopecksToRubles(3500),  35);
    assert.equal(kopecksToRubles(0),     0);
});
