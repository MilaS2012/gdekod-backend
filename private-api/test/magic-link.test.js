// =============================================================================
// magic-link.test.js — generateMagicLinkToken.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMagicLinkToken } from '../lib/magic-link.js';

test('generateMagicLinkToken: base64url, 43 символа, без = padding', () => {
    const t = generateMagicLinkToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
});

test('generateMagicLinkToken: уникален между вызовами', () => {
    const set = new Set();
    for (let i = 0; i < 100; i++) set.add(generateMagicLinkToken());
    assert.equal(set.size, 100);
});
