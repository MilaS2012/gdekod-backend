// =============================================================================
// jwt.test.js — тесты подписи и верификации JWT (этап 6.3.1).
//
// Используем встроенный node:test. Никаких реальных сетевых вызовов —
// jose работает локально с симметричным секретом.
//
// JWT_SECRET для тестов фиксируем здесь же, чтобы тесты были
// воспроизводимыми. Каждый тест восстанавливает исходное значение.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

import { signJwt, verifyJwt, JwtError } from '../lib/jwt.js';

const TEST_SECRET = 'test-secret-min-32-bytes-AAAAAAAAAAAAAAAA';
const OTHER_SECRET = 'other-secret-min-32-bytes-BBBBBBBBBBBBBBBB';

function setEnv() {
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}
function resetEnv() {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_TTL_SECONDS;
}

// -----------------------------------------------------------------------------
// signJwt
// -----------------------------------------------------------------------------

test('signJwt: round-trip — sign → verify даёт ту же payload', async () => {
    setEnv();
    const token = await signJwt({ sub: 'user-123', sid: 'sess-abc' });
    const payload = await verifyJwt(token);
    assert.equal(payload.sub, 'user-123');
    assert.equal(payload.sid, 'sess-abc');
    assert.ok(Number.isInteger(payload.iat));
    assert.ok(Number.isInteger(payload.exp));
    assert.ok(payload.exp > payload.iat);
    resetEnv();
});

test('signJwt: формат header.payload.signature (compact JWS)', async () => {
    setEnv();
    const token = await signJwt({ sub: 'u', sid: 's' });
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert.ok(parts[0].length > 0);
    assert.ok(parts[1].length > 0);
    assert.ok(parts[2].length > 0);
    resetEnv();
});

test('signJwt: header содержит alg=HS256, typ=JWT', async () => {
    setEnv();
    const token = await signJwt({ sub: 'u', sid: 's' });
    const headerJson = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson);
    assert.equal(header.alg, 'HS256');
    assert.equal(header.typ, 'JWT');
    resetEnv();
});

test('signJwt: exp = iat + JWT_TTL_SECONDS из env', async () => {
    setEnv();
    process.env.JWT_TTL_SECONDS = '3600'; // 1 час
    const token = await signJwt({ sub: 'u', sid: 's' });
    const payload = await verifyJwt(token);
    assert.equal(payload.exp - payload.iat, 3600);
    resetEnv();
});

test('signJwt: exp по умолчанию — 90 дней (ТЗ §3.6)', async () => {
    setEnv();
    const token = await signJwt({ sub: 'u', sid: 's' });
    const payload = await verifyJwt(token);
    assert.equal(payload.exp - payload.iat, 60 * 60 * 24 * 90);
    resetEnv();
});

test('signJwt: opts.ttlSeconds переопределяет env', async () => {
    setEnv();
    process.env.JWT_TTL_SECONDS = '3600';
    const token = await signJwt({ sub: 'u', sid: 's' }, { ttlSeconds: 60 });
    const payload = await verifyJwt(token);
    assert.equal(payload.exp - payload.iat, 60);
    resetEnv();
});

test('signJwt: невалидный payload → JwtError(invalid_payload)', async () => {
    setEnv();
    await assert.rejects(() => signJwt(null),                  (e) => e instanceof JwtError && e.code === 'invalid_payload');
    await assert.rejects(() => signJwt({}),                    (e) => e instanceof JwtError && e.code === 'invalid_payload');
    await assert.rejects(() => signJwt({ sub: 'u' }),          (e) => e instanceof JwtError && e.code === 'invalid_payload');
    await assert.rejects(() => signJwt({ sid: 's' }),          (e) => e instanceof JwtError && e.code === 'invalid_payload');
    await assert.rejects(() => signJwt({ sub: 1, sid: 's' }),  (e) => e instanceof JwtError && e.code === 'invalid_payload');
    resetEnv();
});

test('signJwt: без JWT_SECRET → JwtError(no_secret)', async () => {
    resetEnv();
    await assert.rejects(
        () => signJwt({ sub: 'u', sid: 's' }),
        (e) => e instanceof JwtError && e.code === 'no_secret',
    );
});

test('signJwt: JWT_SECRET короче 32 символов → JwtError(no_secret)', async () => {
    process.env.JWT_SECRET = 'short-secret';
    await assert.rejects(
        () => signJwt({ sub: 'u', sid: 's' }),
        (e) => e instanceof JwtError && e.code === 'no_secret',
    );
    resetEnv();
});

// -----------------------------------------------------------------------------
// verifyJwt — отрицательные кейсы
// -----------------------------------------------------------------------------

test('verifyJwt: истёкший токен → JwtError(expired)', async () => {
    setEnv();
    // Выпускаем токен с прошлым exp напрямую через jose.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now - 7200)
        .setExpirationTime(now - 3600) // -1 час
        .sign(new TextEncoder().encode(TEST_SECRET));
    await assert.rejects(
        () => verifyJwt(token),
        (e) => e instanceof JwtError && e.code === 'expired',
    );
    resetEnv();
});

test('verifyJwt: подделанная подпись → JwtError(invalid)', async () => {
    setEnv();
    // Подписываем секретом OTHER_SECRET, проверяем секретом TEST_SECRET.
    const fakeToken = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(OTHER_SECRET));
    await assert.rejects(
        () => verifyJwt(fakeToken),
        (e) => e instanceof JwtError && e.code === 'invalid',
    );
    resetEnv();
});

test('verifyJwt: malformed (мусор вместо JWT) → JwtError(malformed)', async () => {
    setEnv();
    await assert.rejects(() => verifyJwt('not.a.jwt'),       (e) => e instanceof JwtError && e.code === 'malformed');
    await assert.rejects(() => verifyJwt('abc'),             (e) => e instanceof JwtError && e.code === 'malformed');
    await assert.rejects(() => verifyJwt('a.b.c.d.e'),       (e) => e instanceof JwtError && e.code === 'malformed');
    resetEnv();
});

test('verifyJwt: пустой токен → JwtError(malformed)', async () => {
    setEnv();
    await assert.rejects(() => verifyJwt(''),         (e) => e instanceof JwtError && e.code === 'malformed');
    await assert.rejects(() => verifyJwt(null),       (e) => e instanceof JwtError && e.code === 'malformed');
    await assert.rejects(() => verifyJwt(undefined),  (e) => e instanceof JwtError && e.code === 'malformed');
    await assert.rejects(() => verifyJwt(123),        (e) => e instanceof JwtError && e.code === 'malformed');
    resetEnv();
});

test('verifyJwt: подмена alg на HS384 → JwtError(wrong_algorithm)', async () => {
    setEnv();
    // Тот же секрет, но другой алгоритм. Защищаемся pin'ом в jwtVerify(... algorithms: ['HS256']).
    const token = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS384', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(TEST_SECRET));
    await assert.rejects(
        () => verifyJwt(token),
        (e) => e instanceof JwtError && e.code === 'wrong_algorithm',
    );
    resetEnv();
});

test('verifyJwt: payload без sub → JwtError(invalid)', async () => {
    setEnv();
    const token = await new SignJWT({ sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(TEST_SECRET));
    await assert.rejects(
        () => verifyJwt(token),
        (e) => e instanceof JwtError && e.code === 'invalid',
    );
    resetEnv();
});

test('verifyJwt: payload без sid → JwtError(invalid)', async () => {
    setEnv();
    const token = await new SignJWT({ sub: 'u' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(TEST_SECRET));
    await assert.rejects(
        () => verifyJwt(token),
        (e) => e instanceof JwtError && e.code === 'invalid',
    );
    resetEnv();
});

// -----------------------------------------------------------------------------
// JwtError API
// -----------------------------------------------------------------------------

test('JwtError: имеет name "JwtError" и читаемый code', () => {
    const e = new JwtError('expired', 'просрочено');
    assert.equal(e.name, 'JwtError');
    assert.equal(e.code, 'expired');
    assert.equal(e.message, 'просрочено');
    assert.ok(e instanceof Error);
});

// -----------------------------------------------------------------------------
// clockTolerance — допуск ±5 секунд для рассинхронизации часов serverless-инстансов
// -----------------------------------------------------------------------------

test('verifyJwt: JWT истёк 3 секунды назад → проходит (в пределах ±5 сек tolerance)', async () => {
    setEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now - 60)
        .setExpirationTime(now - 3)
        .sign(new TextEncoder().encode(TEST_SECRET));
    const payload = await verifyJwt(token);
    assert.equal(payload.sub, 'u');
    resetEnv();
});

test('verifyJwt: JWT истёк 10 секунд назад → JwtError(expired) (за пределами tolerance)', async () => {
    setEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: 'u', sid: 's' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now - 60)
        .setExpirationTime(now - 10)
        .sign(new TextEncoder().encode(TEST_SECRET));
    await assert.rejects(
        () => verifyJwt(token),
        (e) => e instanceof JwtError && e.code === 'expired',
    );
    resetEnv();
});

// -----------------------------------------------------------------------------
// Безопасность: ни токен, ни секрет не утекают в message/stack JwtError
// -----------------------------------------------------------------------------

test('verifyJwt: при ошибке исходный токен не попадает в message ошибки', async () => {
    setEnv();
    const token = 'eyJhbGciOiJzZWNyZXQifQ.payload.signature';
    try { await verifyJwt(token); assert.fail('должно было упасть'); }
    catch (e) {
        assert.ok(e instanceof JwtError);
        assert.ok(!e.message.includes(token), 'токен попал в JwtError.message');
    }
    resetEnv();
});

test('verifyJwt: при неверном секрете ни секрет, ни его метаданные не утекают в JwtError', async () => {
    // Используем достаточно уникальную строку, чтобы фолс-позитив был
    // невероятен. Подстроки префикса/длины — тоже не должны утечь.
    const SECRET = 'TEST_SECRET_VERY_DISTINCT_xxxxxxxxxx_END';
    process.env.JWT_SECRET = SECRET;
    const token = await signJwt({ sub: 'u', sid: 's' });

    // Меняем секрет, имитируя ротацию / неправильный env.
    process.env.JWT_SECRET = 'DIFFERENT_SECRET_____AAAAAAAAAAAAAAAA';

    let caught;
    try { await verifyJwt(token); }
    catch (e) { caught = e; }

    assert.ok(caught instanceof JwtError, 'ожидали JwtError');
    assert.equal(caught.code, 'invalid');

    const surface = `${caught.message ?? ''}\n${caught.stack ?? ''}`;
    assert.ok(!surface.includes(SECRET),                  'весь секрет утёк в JwtError');
    assert.ok(!surface.includes(SECRET.slice(0, 8)),      'префикс секрета (8 символов) утёк');
    assert.ok(!surface.includes(SECRET.slice(-8)),        'суффикс секрета (8 символов) утёк');
    // Длина-как-число — отдельная проверка, чтобы не пересекалась с другими числами в stack.
    assert.ok(!new RegExp(`\\b${SECRET.length}\\b.*secret`, 'i').test(surface),
              'длина секрета упомянута рядом со словом "secret"');

    resetEnv();
});

test('signJwt: при ошибке payload не утекает в JwtError', async () => {
    // Гипотетический сценарий: вызывающий передал в payload что-то секретное.
    // Наш код не должен включать payload в текст ошибки даже если он
    // оказался невалидным.
    setEnv();
    const SECRET_LIKE = 'SUPER-SENSITIVE-PAYLOAD-VALUE-zzzzzzzzzzzzzz';
    let caught;
    try {
        // sub — это объект, а не строка → invalid_payload
        await signJwt({ sub: { secret: SECRET_LIKE }, sid: 's' });
    } catch (e) { caught = e; }

    assert.ok(caught instanceof JwtError);
    assert.equal(caught.code, 'invalid_payload');
    const surface = `${caught.message ?? ''}\n${caught.stack ?? ''}`;
    assert.ok(!surface.includes(SECRET_LIKE), 'значение payload утекло в JwtError');
    resetEnv();
});
