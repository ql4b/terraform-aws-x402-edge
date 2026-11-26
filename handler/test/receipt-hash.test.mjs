// Run with `npm test`. Exercises the real @x402/core and @x402/extensions with a
// stub facilitator and a capturing receipt issuer (no network, no keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import { x402ResourceServer } from '@x402/core/server';
import { createOfferReceiptExtension } from '@x402/extensions/offer-receipt';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPendingSettlement } = require('./.build/settlement-context.cjs');

const requirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x0000000000000000000000000000000000000001',
  maxTimeoutSeconds: 300,
  extra: {},
};
const payload = { x402Version: 2, accepted: requirements, payload: {} };
const offerReceipt = { enabled: true, includeTxHash: true, offerValiditySeconds: 300 };
const TX = '0x' + 'ab'.repeat(32);

function setup() {
  const receipts = [];
  const issuer = {
    kid: 'k',
    format: 'eip712',
    issueOffer: async () => ({ format: 'eip712', payload: {}, signature: '0xoffer' }),
    issueReceipt: async (resourceUrl, payer, network, transaction) => {
      receipts.push(transaction);
      return { format: 'eip712', payload: { transaction: transaction ?? '' }, signature: '0xreceipt' };
    },
  };
  const facilitator = {
    verify: async () => ({ isValid: true, payer: '0x0000000000000000000000000000000000000002' }),
    settle: async () => ({ success: true, transaction: TX, network: requirements.network, payer: '0x0000000000000000000000000000000000000002' }),
    getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
  };
  const server = new x402ResourceServer(facilitator);
  server.registerExtension(createOfferReceiptExtension(issuer));
  const adapter = { getUrl: () => 'https://example.com/v1/paid', getMethod: () => 'GET' };
  return { server, receipts, transportContext: { request: { adapter, path: '/v1/paid', method: 'GET' } } };
}

test('the receipt carries the transaction hash when settlement gets the carried declaration', async () => {
  const { server, receipts, transportContext } = setup();
  const carried = buildPendingSettlement(
    { paymentPayload: payload, paymentRequirements: requirements },
    offerReceipt,
    'd'
  );
  const result = await server.settlePayment(payload, requirements, carried.declaredExtensions, transportContext);
  assert.equal(result.success, true);
  assert.deepEqual(receipts, [TX]);
});

test('with the declaration overwritten by 402 data, the receipt has no hash (the bug being avoided)', async () => {
  const { server, receipts, transportContext } = setup();
  const declared = { 'offer-receipt': { includeTxHash: true, offerValiditySeconds: 300 } };
  // In @x402/core < 2.29 this writes the signed offers into `declared` itself.
  await server.createPaymentRequiredResponse([requirements], { url: 'https://example.com/v1/paid' }, undefined, declared, transportContext);
  await server.settlePayment(payload, requirements, declared, transportContext);
  assert.equal(receipts.length, 1);
  if (declared['offer-receipt'].includeTxHash === undefined) {
    assert.equal(receipts[0], undefined); // aliasing SDK: hash dropped
  } else {
    assert.equal(receipts[0], TX); // fixed SDK (>= 2.29): declaration intact
  }
});
