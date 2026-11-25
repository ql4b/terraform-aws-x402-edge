// Run with `npm test` (builds src/lib to test/.build first).
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCanonicalRequestPath } = require('./.build/request-path.cjs');
const { createX402Middleware } = require('./.build/middleware.cjs');

const canonical = [
  '/',
  '/v1/data',
  '/v1/data/',
  '/a/b/c.json',
  '/anything/premium/item-1',
  '/v1/caf%C3%A9', // other percent-encoding is fine
  '/v1/a.b/c..d', // dots inside a segment are fine
  '/v1/.well-known/x402',
];

const nonCanonical = [
  '',
  'v1/data', // no leading slash
  '/v1/a/../b', // dot-segment
  '/v1/a/./b',
  '/v1/a/..',
  '/v1/a/../../b',
  '/v1/a/..;/b', // path parameter on a dot-segment
  '/v1/a//b', // empty segment
  '//v1/a',
  '/v1/a%2F..%2Fb', // encoded slash
  '/v1/a%2f..%2fb',
  '/v1/a/%2e%2e/b', // encoded dots
  '/v1/a/%2E%2E/b',
  '/v1/a/.%2e/b',
  '/v1/a%252F..%252Fb', // double encoding
  '/v1/a/%252e%252e/b',
  '/v1/a%5cb', // encoded backslash
  '/v1/a\\b', // literal backslash
  '/v1/a%00b', // encoded NUL
  '/v1/a\u0000b', // NUL
  '/v1/a\nb',
  '/v1/a%7fb',
  '/v1/a%zz', // malformed escape
  '/v1/a%',
  '/v1/a%2',
];

test('canonical paths are accepted', () => {
  for (const p of canonical) assert.equal(isCanonicalRequestPath(p), true, p);
});

test('non-canonical paths are rejected', () => {
  for (const p of nonCanonical) assert.equal(isCanonicalRequestPath(p), false, JSON.stringify(p));
});

test('non-string input is rejected', () => {
  for (const v of [undefined, null, 42, {}, []]) assert.equal(isCanonicalRequestPath(v), false);
});

test('origin-request rejects a non-canonical path with 400 before any route or facilitator work', async () => {
  // A dummy config: the check runs before the server (and so the facilitator or
  // Secrets Manager) is initialised, so nothing here may touch the network.
  const mw = createX402Middleware({ routes: {}, facilitatorUrl: 'http://127.0.0.1:1' });
  for (const uri of ['/v1/x/../paid', '/v1/x%252F..%252Fpaid', '/v1/x%2e%2e/paid']) {
    const request = { uri, method: 'GET', querystring: '', headers: {} };
    const out = await mw.processOriginRequest(request, 'd111.cloudfront.net');
    assert.equal(out.type, 'respond', uri);
    assert.equal(out.response.status, '400', uri);
  }
});
