// Run with `npm test` (builds src/lib to test/.build first).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareVerifiedRequestForOrigin,
  headerBytes,
  PENDING_SETTLEMENT_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} = require('./.build/forward.cjs');

const h = (key, value) => [{ key, value }];

function paidRequest(signatureBytes) {
  return {
    uri: '/v1/paid',
    method: 'GET',
    querystring: '',
    headers: {
      'user-agent': h('User-Agent', 'node'),
      'cloudfront-viewer-ja4-fingerprint': h('CloudFront-Viewer-JA4-Fingerprint', 't13d1311h2_a44d0ee8b3cc_485d6013ba69'),
      [PAYMENT_SIGNATURE_HEADER]: h('PAYMENT-SIGNATURE', 'S'.repeat(signatureBytes)),
    },
  };
}

test('the viewer PAYMENT-SIGNATURE is not forwarded to the origin', () => {
  const request = paidRequest(3700);
  prepareVerifiedRequestForOrigin(request, 'P'.repeat(10));
  assert.equal(request.headers[PAYMENT_SIGNATURE_HEADER], undefined);
});

test('the pending-settlement payload is attached', () => {
  const request = paidRequest(10);
  prepareVerifiedRequestForOrigin(request, 'cGVuZGluZw==');
  assert.deepEqual(request.headers[PENDING_SETTLEMENT_HEADER], [
    { key: PENDING_SETTLEMENT_HEADER, value: 'cGVuZGluZw==' },
  ]);
});

test('other viewer headers (including forwarded telemetry headers) are kept', () => {
  const request = paidRequest(10);
  prepareVerifiedRequestForOrigin(request, 'x');
  assert.ok(request.headers['user-agent']);
  assert.ok(request.headers['cloudfront-viewer-ja4-fingerprint']);
});

test('with realistic sizes the forwarded headers stay well under a ~10 KB origin limit', () => {
  // Sizes observed on a live route: PAYMENT-SIGNATURE ~3.7 KB, pending payload
  // ~6.3 KB. Forwarding both put the request over a Lambda Function URL limit.
  const request = paidRequest(3700);
  const before = headerBytes(request.headers) + PENDING_SETTLEMENT_HEADER.length + 4 + 6300;
  const after = prepareVerifiedRequestForOrigin(request, 'P'.repeat(6300));
  assert.ok(before > 10_000, `before=${before}`);
  assert.ok(after < 7_000, `after=${after}`);
  assert.equal(before - after, PAYMENT_SIGNATURE_HEADER.length + 4 + 3700);
});

test('headerBytes counts name, value and separators per value', () => {
  assert.equal(headerBytes({ a: h('A', 'bc') }), 1 + 2 + 2 + 2);
  assert.equal(headerBytes({ a: [{ key: 'A', value: 'x' }, { key: 'A', value: 'y' }] }), 2 * (1 + 2 + 1 + 2));
  assert.equal(headerBytes({}), 0);
});
