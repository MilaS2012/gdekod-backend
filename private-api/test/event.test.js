// =============================================================================
// event.test.js — extractIp, extractUserAgent, userAgentHash.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractIp, extractUserAgent, userAgentHash, parseUserAgent } from '../lib/event.js';

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

// -----------------------------------------------------------------------------
// parseUserAgent — UI-метка устройства
// -----------------------------------------------------------------------------

test('parseUserAgent: Chrome на macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    assert.equal(parseUserAgent(ua), 'Chrome 120 on macOS');
});

test('parseUserAgent: Safari на iPhone (через Version/X.*Safari)', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
    assert.equal(parseUserAgent(ua), 'Safari 17 on iPhone');
});

test('parseUserAgent: Yandex Browser на Windows 10 (Yandex перед Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 YaBrowser/23.11.0.2630 Safari/537.36';
    assert.equal(parseUserAgent(ua), 'Yandex 23 on Windows 10');
});

test('parseUserAgent: Edge на Windows 11 (Edge перед Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    assert.equal(parseUserAgent(ua), 'Edge 120 on Windows 11');
});

test('parseUserAgent: Firefox на Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
    assert.equal(parseUserAgent(ua), 'Firefox 121 on Linux');
});

test('parseUserAgent: Chrome на Android (Android перед Linux)', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';
    assert.equal(parseUserAgent(ua), 'Chrome 119 on Android');
});

test('parseUserAgent: пустая строка / не-строка → "Unknown device"', () => {
    assert.equal(parseUserAgent(''),         'Unknown device');
    assert.equal(parseUserAgent(null),       'Unknown device');
    assert.equal(parseUserAgent(undefined),  'Unknown device');
    assert.equal(parseUserAgent(123),        'Unknown device');
});

test('parseUserAgent: очень длинная UA → результат не более 100 chars', () => {
    const ua = 'Mozilla/5.0 ' + 'A'.repeat(500) + ' Chrome/120 ' + 'B'.repeat(500) + ' macOS';
    const result = parseUserAgent(ua);
    assert.ok(result.length <= 100, `длина ${result.length} > 100`);
});
