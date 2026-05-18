// =============================================================================
// rate-limit.test.js — тесты smsRateCheck и emailRateCheck (этап 6.3.3).
//
// На каждый тест — свежий pg-mem-pool. Записи создаются с явным created_at
// в прошлом (insertUsedOtp / insertUsedMagicLink из helpers), чтобы
// проверять окна 60 сек / 24 часа без реального ожидания.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { smsRateCheck, emailRateCheck, LIMITS } from '../lib/rate-limit.js';
import {
    newPgMemPool,
    createTestUser,
    insertUsedOtp,
    insertUsedMagicLink,
} from './helpers.js';

const PHONE_A = '+79261111111';
const PHONE_B = '+79262222222';
const IP_A    = '203.0.113.7';

// =============================================================================
// Группа A — SMS cooldown
// =============================================================================

test('A1: первый запрос на номер → allowed', async () => {
    const pool = await newPgMemPool();
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.deepEqual(r, { allowed: true });
});

test('A2: повторный запрос через 30 секунд → cooldown с retryAfterSeconds≈30', async () => {
    const pool = await newPgMemPool();
    await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 30 });
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'cooldown');
    assert.ok(r.retryAfterSeconds >= 28 && r.retryAfterSeconds <= 32,
              `retryAfterSeconds=${r.retryAfterSeconds}, ожидали ~30`);
});

test('A3: повторный запрос через 61 секунду → allowed (вышли из cooldown)', async () => {
    const pool = await newPgMemPool();
    await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 61 });
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.allowed, true);
});

// =============================================================================
// Группа B — SMS daily per phone
// =============================================================================

test('B4: ровно 5 OTP за сутки на номер → 6-й запрос отбит daily_limit_phone', async () => {
    const pool = await newPgMemPool();
    // 5 OTP, все старше 60 сек (вне cooldown), но в пределах 24 часов.
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_PHONE; i++) {
        await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'daily_limit_phone');
});

test('B5: 4 OTP за сутки → 5-й allowed (граница лимита)', async () => {
    const pool = await newPgMemPool();
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_PHONE - 1; i++) {
        await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.allowed, true);
});

test('B6: 5 старых OTP (>25 часов назад) → текущий запрос allowed (выпали из окна)', async () => {
    const pool = await newPgMemPool();
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_PHONE; i++) {
        await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 25 * 3600 + i * 60 });
    }
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.allowed, true);
});

// =============================================================================
// Группа C — SMS daily per IP
// =============================================================================

test('C7: 20 OTP с одного IP на 20 разных номеров → 21-й (новый номер) отбит daily_limit_ip', async () => {
    const pool = await newPgMemPool();
    // 20 разных номеров, всё с IP_A, в пределах суток, вне cooldown.
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_IP; i++) {
        const phone = `+7926${String(i).padStart(7, '0')}`;
        await insertUsedOtp(pool, { phone, ip: IP_A, createdAtOffsetSeconds: 120 + i * 30 });
    }
    // 21-й номер, тот же IP.
    const newPhone = '+79264444444';
    const r = await smsRateCheck({ phone: newPhone, ip: IP_A }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'daily_limit_ip');
});

test('C8: 19 OTP с IP → 20-й allowed (граница лимита по IP)', async () => {
    const pool = await newPgMemPool();
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_IP - 1; i++) {
        const phone = `+7926${String(i).padStart(7, '0')}`;
        await insertUsedOtp(pool, { phone, ip: IP_A, createdAtOffsetSeconds: 120 + i * 30 });
    }
    const r = await smsRateCheck({ phone: '+79265555555', ip: IP_A }, { pool });
    assert.equal(r.allowed, true);
});

// =============================================================================
// Группа D — Email magic-link cooldown
// =============================================================================

test('D9: первый magic link → allowed', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    const r = await emailRateCheck({ user_id }, { pool });
    assert.deepEqual(r, { allowed: true });
});

test('D10: повторный magic link через 30 сек → cooldown', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await insertUsedMagicLink(pool, { user_id, createdAtOffsetSeconds: 30 });
    const r = await emailRateCheck({ user_id }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'cooldown');
    assert.ok(r.retryAfterSeconds >= 28 && r.retryAfterSeconds <= 32);
});

test('D11: повторный magic link через 61 сек → allowed', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    await insertUsedMagicLink(pool, { user_id, createdAtOffsetSeconds: 61 });
    const r = await emailRateCheck({ user_id }, { pool });
    assert.equal(r.allowed, true);
});

// =============================================================================
// Группа E — Email daily per user
// =============================================================================

test('E12: ровно 10 magic-link за сутки → 11-й отбит daily_limit_email', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    for (let i = 0; i < LIMITS.EMAIL_DAILY_PER_USER; i++) {
        await insertUsedMagicLink(pool, { user_id, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const r = await emailRateCheck({ user_id }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'daily_limit_email');
});

test('E13: 9 magic-link за сутки → 10-й allowed (граница лимита)', async () => {
    const pool = await newPgMemPool();
    const { user_id } = await createTestUser(pool);
    for (let i = 0; i < LIMITS.EMAIL_DAILY_PER_USER - 1; i++) {
        await insertUsedMagicLink(pool, { user_id, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const r = await emailRateCheck({ user_id }, { pool });
    assert.equal(r.allowed, true);
});

// =============================================================================
// Группа F — retryAfterSeconds точность
// =============================================================================

test('F14: retryAfterSeconds = 60 - возраст последнего запроса (±1 сек)', async () => {
    const pool = await newPgMemPool();
    // Последний запрос 10 секунд назад → retryAfter ≈ 50
    await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 10 });
    const r = await smsRateCheck({ phone: PHONE_A }, { pool });
    assert.equal(r.reason, 'cooldown');
    assert.ok(r.retryAfterSeconds >= 49 && r.retryAfterSeconds <= 51,
              `retryAfterSeconds=${r.retryAfterSeconds}, ожидали ~50`);
});

// =============================================================================
// Группа G — порядок проверок: daily_limit_ip имеет приоритет
// =============================================================================

test('19: при ботнет-флуде с IP + свежий phone-cooldown → reason=daily_limit_ip (IP-first)', async () => {
    const pool = await newPgMemPool();
    // Заполняем дневной лимит IP: 20 OTP с одного IP на 20 разных номеров.
    for (let i = 0; i < LIMITS.SMS_DAILY_PER_IP; i++) {
        const phone = `+7926${String(i).padStart(7, '0')}`;
        await insertUsedOtp(pool, { phone, ip: IP_A, createdAtOffsetSeconds: 120 + i * 30 });
    }
    // На целевой phone — свежий OTP (10 сек назад), чтобы сработал бы и cooldown.
    const targetPhone = '+79269999999';
    await insertUsedOtp(pool, { phone: targetPhone, ip: '192.0.2.1', createdAtOffsetSeconds: 10 });

    // Запрос с этого IP на этот phone → должен упасть на daily_limit_ip,
    // НЕ на cooldown. Это проверяет, что IP-проверка идёт первой.
    const r = await smsRateCheck({ phone: targetPhone, ip: IP_A }, { pool });
    assert.equal(r.allowed, false);
    assert.equal(r.reason,  'daily_limit_ip', 'IP-проверка должна срабатывать первой');
});

// =============================================================================
// Граничные кейсы: разные номера / разные user_id — независимы
// =============================================================================

test('изоляция: cooldown на PHONE_A не влияет на PHONE_B', async () => {
    const pool = await newPgMemPool();
    await insertUsedOtp(pool, { phone: PHONE_A, createdAtOffsetSeconds: 10 });
    const r = await smsRateCheck({ phone: PHONE_B }, { pool });
    assert.equal(r.allowed, true);
});

test('изоляция: daily на одном user_id не влияет на другого', async () => {
    const pool = await newPgMemPool();
    const { user_id: alice } = await createTestUser(pool);
    const { user_id: bob   } = await createTestUser(pool);
    for (let i = 0; i < LIMITS.EMAIL_DAILY_PER_USER; i++) {
        await insertUsedMagicLink(pool, { user_id: alice, createdAtOffsetSeconds: 120 + i * 60 });
    }
    const aliceResult = await emailRateCheck({ user_id: alice }, { pool });
    const bobResult   = await emailRateCheck({ user_id: bob   }, { pool });
    assert.equal(aliceResult.allowed, false);
    assert.equal(bobResult.allowed,   true);
});

// =============================================================================
// Валидация входа
// =============================================================================

test('smsRateCheck: phone обязателен', async () => {
    const pool = await newPgMemPool();
    await assert.rejects(() => smsRateCheck({}, { pool }), /phone обязателен/);
    await assert.rejects(() => smsRateCheck({ phone: '' }, { pool }), /phone обязателен/);
});

test('emailRateCheck: user_id обязателен', async () => {
    const pool = await newPgMemPool();
    await assert.rejects(() => emailRateCheck({}, { pool }), /user_id обязателен/);
});
