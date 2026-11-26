// Run with `npm test` (builds src/lib to test/.build first).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPendingSettlement, offerReceiptDeclaration, settlementDeclaredExtensions } = require('./.build/settlement-context.cjs');

const offerReceipt = {
  enabled: true,
  format: 'eip712',
  signingKeySecretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:k',
  kid: 'did:web:example.com#key-1',
  includeTxHash: true,
  offerValiditySeconds: 300,
  cacheTtlSeconds: 300,
};

const verified = {
  paymentPayload: { x402Version: 2, payload: { signature: '0xsig' } },
  paymentRequirements: { scheme: 'exact', network: 'eip155:8453', amount: '1000' },
  // What processHTTPRequest returns as declaredExtensions in @x402/core < 2.29:
  // the 402 builder has replaced the offer-receipt declaration with the 402
  // data (signed offers), and bazaar carries its full info and schemas.
  declaredExtensions: {
    bazaar: { info: { name: 'x', description: 'd'.repeat(800) }, schema: { big: 's'.repeat(800) } },
    'offer-receipt': { info: { offers: [{ signature: '0x' + 'a'.repeat(130) }] }, schema: {} },
  },
};

test('offer-receipt off: carries payload, requirements and the distribution domain, no declaration', () => {
  const out = buildPendingSettlement(verified, undefined, 'd111.cloudfront.net');
  assert.deepEqual(Object.keys(out).sort(), ['distributionDomain', 'payload', 'requirements']);
  assert.equal(out.distributionDomain, 'd111.cloudfront.net');
  assert.deepEqual(buildPendingSettlement(verified, { ...offerReceipt, enabled: false }, 'd111.cloudfront.net'), out);
});

test('offer-receipt on: carries the declaration from config and the distribution domain', () => {
  const out = buildPendingSettlement(verified, offerReceipt, 'd111.cloudfront.net');
  assert.deepEqual(out.declaredExtensions, {
    'offer-receipt': { includeTxHash: true, offerValiditySeconds: 300 },
  });
  assert.equal(out.distributionDomain, 'd111.cloudfront.net');
  assert.equal(out.payload, verified.paymentPayload);
  assert.equal(out.requirements, verified.paymentRequirements);
});

test('the mutated declaredExtensions from processHTTPRequest are not carried', () => {
  const out = buildPendingSettlement(verified, offerReceipt, 'd');
  const json = JSON.stringify(out);
  assert.ok(!json.includes('bazaar'));
  assert.ok(!json.includes('offers'));
  assert.equal(out.declaredExtensions['offer-receipt'].includeTxHash, true);
});

test('includeTxHash false is carried as false', () => {
  const out = buildPendingSettlement(verified, { ...offerReceipt, includeTxHash: false }, 'd');
  assert.equal(out.declaredExtensions['offer-receipt'].includeTxHash, false);
});

test('the carried declaration is a fresh object per request', () => {
  const a = buildPendingSettlement(verified, offerReceipt, 'd');
  a.declaredExtensions['offer-receipt'] = { info: 'mutated' };
  const b = buildPendingSettlement(verified, offerReceipt, 'd');
  assert.equal(b.declaredExtensions['offer-receipt'].includeTxHash, true);
});

test('offerReceiptDeclaration is undefined when disabled', () => {
  assert.equal(offerReceiptDeclaration(undefined), undefined);
  assert.equal(offerReceiptDeclaration({ ...offerReceipt, enabled: false }), undefined);
});

test('the carried payload is smaller than carrying the declared extensions', () => {
  const before = JSON.stringify({
    payload: verified.paymentPayload,
    requirements: verified.paymentRequirements,
    declaredExtensions: verified.declaredExtensions,
    distributionDomain: 'd',
  }).length;
  const after = JSON.stringify(buildPendingSettlement(verified, offerReceipt, 'd')).length;
  assert.ok(before - after > 1500, `before=${before} after=${after}`);
});

// settlementDeclaredExtensions: what origin-response settles with.

test('settle: the carried declaration wins over this function\'s config', () => {
  const carried = buildPendingSettlement(verified, { ...offerReceipt, includeTxHash: false }, 'd');
  const out = settlementDeclaredExtensions(carried, { ...offerReceipt, includeTxHash: true, offerValiditySeconds: 60 });
  assert.deepEqual(out, { 'offer-receipt': { includeTxHash: false, offerValiditySeconds: 300 } });
});

test('settle: nothing carried but offer-receipt on here -> this function\'s declaration (best effort)', () => {
  const carried = buildPendingSettlement(verified, undefined, 'd');
  const out = settlementDeclaredExtensions(carried, offerReceipt);
  assert.deepEqual(out, { 'offer-receipt': { includeTxHash: true, offerValiditySeconds: 300 } });
});

test('settle: nothing carried and offer-receipt off here -> no declaration', () => {
  const carried = buildPendingSettlement(verified, undefined, 'd');
  assert.equal(settlementDeclaredExtensions(carried, undefined), undefined);
  assert.equal(settlementDeclaredExtensions(carried, { ...offerReceipt, enabled: false }), undefined);
});

test('settle: an older pending header (no distributionDomain, mutated extensions) still parses', () => {
  const old = { payload: {}, requirements: {}, declaredExtensions: verified.declaredExtensions };
  assert.equal(settlementDeclaredExtensions(old, offerReceipt), verified.declaredExtensions);
});
