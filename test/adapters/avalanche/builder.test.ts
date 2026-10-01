import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import {
  avalancheBroadcaster,
  avalancheBuilder,
} from '../../../src/adapters/avalanche/builder';
import { parseSignedTx } from '../../../src/adapters/avalanche/codec';
import { proofSource } from '../../../src/adapters/avalanche/proofs';
import { chainReader } from '../../../src/adapters/avalanche/reader';
import type { BuildContext } from '../../../src/core/driver/types';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { UnsignedTx } from '../../../src/core/model/transaction';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { avalancheHarness, type Harness } from './support/harness';
import { signWith } from './support/node';
import { OTHER_BYTES, TEST_BYTES, TEST_KEY, type Vm } from './support/vectors';

const VMS: readonly Vm[] = ['avm', 'pvm'];

function intentOf(
  h: Harness,
  amount: bigint,
  extra: Partial<DriverIntent> = {},
): DriverIntent {
  return {
    asset: 'native',
    outputs: [{ to: h.address(OTHER_BYTES), amount }],
    from: h.from,
    fee: 'normal',
    ...extra,
  };
}

const buildOf = (h: Harness, extra: Partial<BuildContext> = {}): BuildContext => ({
  from: h.from,
  keys: h.keys,
  wallet: {},
  ...extra,
});

function signatureOf(unsigned: UnsignedTx) {
  const request = unsigned.signingRequests[0];
  if (!request) throw new Error('no request');
  const sig = secp256k1.sign(request.payload, TEST_KEY, { lowS: true });
  return [
    { requestId: request.id, bytes: sig.toCompactRawBytes(), recovery: sig.recovery },
  ];
}

async function prepared(
  h: Harness,
  amount = 2_000_000n,
  extra: Partial<DriverIntent> = {},
) {
  const builder = avalancheBuilder(h.ctx);
  const intent = intentOf(h, amount, extra);
  const fee = await h.run(builder.estimateFee(intent, buildOf(h)));
  const unsigned = await h.run(builder.build(intent, fee, buildOf(h)));
  return { builder, intent, fee, unsigned };
}

describe.each(VMS)('the %s builder over the scripted node', (vm) => {
  it('builds, signs, broadcasts and proves a transfer final', async () => {
    const h = avalancheHarness({ vm });
    h.node.fund(TEST_BYTES, 50_000_000n);
    const { builder, fee, unsigned } = await prepared(h);
    expect(fee.kind).toBe('avalanche');
    expect(fee.bound).toBe('expected');
    expect(unsigned.fee.bound).toBe('exact');
    expect(unsigned.signingRequests).toHaveLength(1);
    expect(unsigned.signingRequests[0]?.payload).toEqual(
      sha256(fromHex(unsigned.payload.data)),
    );
    expect(unsigned.ordering.kind).toBe('inputs');
    const signed = await h.run(builder.assemble(unsigned, signatureOf(unsigned)));
    // The same bytes as a wallet that signs the unsigned transaction itself.
    expect(signed.raw.data).toBe(
      toHex(signWith(fromHex(unsigned.payload.data), TEST_KEY, vm)),
    );
    expect(parseSignedTx(fromHex(signed.raw.data), h.config).id).toBe(signed.ref.id);
    const result = await h.run(avalancheBroadcaster(h.ctx).broadcast(signed));
    expect(result).toEqual({ kind: 'accepted' });
    h.node.mine();
    const reader = chainReader(h.ctx);
    const seen = await h.run(reader.observe(signed.ref, unsigned.ordering, h.from));
    expect(seen).toMatchObject({ seen: 'block', blockHeight: 2n, success: true });
    const proof = await h.run(
      proofSource(h.ctx).includedFinal(signed.ref, unsigned.ordering, h.from),
    );
    expect(proof).toMatchObject({ included: true, success: true, blockHeight: 2n });
    expect(h.node.balance(OTHER_BYTES)).toBe(2_000_000n);
    const paid = unsigned.fee.charges[0]?.amount ?? 0n;
    expect(h.node.balance(TEST_BYTES)).toBe(50_000_000n - 2_000_000n - paid);
    if (vm === 'avm') expect(paid).toBe(1_000_000n);
    else expect(paid).toBeGreaterThan(0n);
  });
});
