// =============================================================================
// parser-auth.test.js — requireParserSecret (6.8 Group A).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { requireParserSecret, ParserAuthError } from '../lib/parser-auth.js';

const SECRET = 'parser-secret-very-long-32-bytes-AAAAAA';

const savedSecret = process.env.PARSER_SECRET;
function setSecret(v) {
    if (v === undefined) delete process.env.PARSER_SECRET;
    else                  process.env.PARSER_SECRET = v;
}
function restoreSecret() { setSecret(savedSecret); }

function eventWith(header) {
    return { headers: header == null ? {} : { 'x-parser-secret': header } };
}

// =============================================================================
// A1-A6
// =============================================================================

test('A1: нет заголовка → ParserAuthError(no_header)', () => {
    setSecret(SECRET);
    assert.throws(
        () => requireParserSecret(eventWith(null)),
        (e) => e instanceof ParserAuthError && e.reason === 'no_header',
    );
    restoreSecret();
});

test('A2: неверный секрет → ParserAuthError(invalid_secret)', () => {
    setSecret(SECRET);
    const wrong = 'wrong-secret-' + 'X'.repeat(SECRET.length - 13);
    assert.equal(wrong.length, SECRET.length);  // sanity
    assert.throws(
        () => requireParserSecret(eventWith(wrong)),
        (e) => e instanceof ParserAuthError && e.reason === 'invalid_secret',
    );
    restoreSecret();
});

test('A3: правильный секрет → true', () => {
    setSecret(SECRET);
    assert.equal(requireParserSecret(eventWith(SECRET)), true);
    restoreSecret();
});

test('A4: разная длина (префикс совпадает) → invalid_secret', () => {
    setSecret(SECRET);
    const shortPrefix = SECRET.slice(0, 10);  // короче, но префикс настоящего
    assert.throws(
        () => requireParserSecret(eventWith(shortPrefix)),
        (e) => e instanceof ParserAuthError && e.reason === 'invalid_secret',
    );
    restoreSecret();
});

test('A5: нет PARSER_SECRET в env → ParserAuthError(no_env_secret)', () => {
    setSecret(undefined);
    assert.throws(
        () => requireParserSecret(eventWith(SECRET)),
        (e) => e instanceof ParserAuthError && e.reason === 'no_env_secret',
    );
    restoreSecret();
});

test('A5b: PARSER_SECRET = пустая строка → no_env_secret', () => {
    setSecret('');
    assert.throws(
        () => requireParserSecret(eventWith(SECRET)),
        (e) => e instanceof ParserAuthError && e.reason === 'no_env_secret',
    );
    restoreSecret();
});

test('A-case-insensitive header: X-Parser-Secret (TitleCase) тоже работает', () => {
    setSecret(SECRET);
    const event = { headers: { 'X-Parser-Secret': SECRET } };
    assert.equal(requireParserSecret(event), true);
    restoreSecret();
});

test('A6: реализация вызывает timingSafeEqual (документация инварианта)', async () => {
    // ⚠️ Эмпирический timing-тест на JS-уровне нестабилен: JS-обвязка
    // (Buffer.from, throw ParserAuthError, GC) даёт 10-60% шума, на CI
    // тест становится flaky. Гарантия constant-time даётся самой функцией
    // crypto.timingSafeEqual (внутри использует CRYPTO_memcmp, документировано
    // в Node.js core).
    //
    // Здесь проверяем СТАТИЧНО: исходный код lib/parser-auth.js содержит
    // `timingSafeEqual`, не наивное `===` сравнение. Это страж-тест против
    // случайного рефакторинга «for performance».
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../lib/parser-auth.js', import.meta.url));
    const src = await readFile(path, 'utf8');

    assert.match(src, /timingSafeEqual/, 'parser-auth.js должен использовать timingSafeEqual');
    // Защита от регрессии: убеждаемся что нет наивного сравнения header'а с
    // ожидаемым через `===`.
    assert.doesNotMatch(src, /header\s*===\s*expected/,
        'parser-auth.js НЕ должен использовать "===" для сравнения секретов');
});
