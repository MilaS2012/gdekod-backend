// =============================================================================
// tokens.test.js — generateRandomToken (refactor из lib/magic-link.js в 6.4).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateRandomToken } from '../lib/tokens.js';

test('generateRandomToken: default 32 байта → base64url 43 символа без = padding', () => {
    const t = generateRandomToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
});

test('generateRandomToken: явный bytes = 32', () => {
    assert.match(generateRandomToken(32), /^[A-Za-z0-9_-]{43}$/);
});

test('generateRandomToken: bytes = 16 → 22 символа', () => {
    assert.match(generateRandomToken(16), /^[A-Za-z0-9_-]{22}$/);
});

test('generateRandomToken: уникален между вызовами', () => {
    const set = new Set();
    for (let i = 0; i < 100; i++) set.add(generateRandomToken());
    assert.equal(set.size, 100);
});

test('generateRandomToken: невалидный bytes → throws', () => {
    assert.throws(() => generateRandomToken(0),    /16\.\.64/);
    assert.throws(() => generateRandomToken(8),    /16\.\.64/);
    assert.throws(() => generateRandomToken(128),  /16\.\.64/);
    assert.throws(() => generateRandomToken(-1),   /16\.\.64/);
    assert.throws(() => generateRandomToken(32.5), /16\.\.64/);
    assert.throws(() => generateRandomToken('32'), /16\.\.64/);
});
