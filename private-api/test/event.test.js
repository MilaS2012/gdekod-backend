// =============================================================================
// event.test.js — extractIp, extractUserAgent, userAgentHash.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractIp, extractUserAgent, userAgentHash } from '../lib/event.js';

// -----------------------------------------------------------------------------
// extractIp
// -----------------------------------------------------------------------------

test('extractIp: requestContext.identity.sourceIp — приоритет 1', () => {
    const e = {
        requestContext: { identity: { sourceIp: '203.0.113.5' } },
        headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    };
    assert.equal(extractIp(e), '203.0.113.5');
});

test('extractIp: нет sourceIp → берёт первый из X-Forwarded-For', () => {
    const e = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.16.0.1' } };
    assert.equal(extractIp(e), '203.0.113.5');
});

test('extractIp: X-Forwarded-For без пробелов — тоже работает', () => {
    const e = { headers: { 'x-forwarded-for': '203.0.113.5,10.0.0.1' } };
    assert.equal(extractIp(e), '203.0.113.5');
});

test('extractIp: header-имя case-insensitive (X-Forwarded-For)', () => {
    const e = { headers: { 'X-Forwarded-For': '203.0.113.5' } };
    assert.equal(extractIp(e), '203.0.113.5');
});

test('extractIp: нет ни sourceIp ни XFF → null', () => {
    assert.equal(extractIp({}),                 null);
    assert.equal(extractIp({ headers: {} }),     null);
    assert.equal(extractIp({ headers: { 'x-forwarded-for': '' } }), null);
});

// -----------------------------------------------------------------------------
// extractUserAgent
// -----------------------------------------------------------------------------

test('extractUserAgent: lowercase header', () => {
    const e = { headers: { 'user-agent': 'Mozilla/5.0 (test)' } };
    assert.equal(extractUserAgent(e), 'Mozilla/5.0 (test)');
});

test('extractUserAgent: TitleCase header', () => {
    const e = { headers: { 'User-Agent': 'curl/8' } };
    assert.equal(extractUserAgent(e), 'curl/8');
});

test('extractUserAgent: нет UA → null', () => {
    assert.equal(extractUserAgent({}),           null);
    assert.equal(extractUserAgent({ headers: {} }), null);
});

// -----------------------------------------------------------------------------
// userAgentHash
// -----------------------------------------------------------------------------

test('userAgentHash: SHA-256 hex, 64 символа', () => {
    const h = userAgentHash('Mozilla/5.0 (Macintosh; ...)');
    assert.match(h, /^[0-9a-f]{64}$/);
});

test('userAgentHash: детерминированно', () => {
    assert.equal(userAgentHash('curl/8'), userAgentHash('curl/8'));
    assert.notEqual(userAgentHash('curl/8'), userAgentHash('curl/9'));
});

test('userAgentHash: null/пустое → null', () => {
    assert.equal(userAgentHash(null),       null);
    assert.equal(userAgentHash(''),         null);
    assert.equal(userAgentHash(undefined),  null);
    assert.equal(userAgentHash(123),        null);
});
