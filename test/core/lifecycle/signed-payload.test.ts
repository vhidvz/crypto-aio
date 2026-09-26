// P3-B (ruling A6): `submitSignatures` also takes a payload signed elsewhere, whose
// signatures the driver extracts; the core verifies each one like any bundle.
import { internalsOf } from '../../../src/core/blockchain/internal';
import { ValidationError } from '../../../src/core/errors/error';
import type { RawTx, UnsignedTx } from '../../../src/core/model/transaction';
import { localSigner } from '../../../src/core/signing/local';
import type { SignatureBundle, Signer } from '../../../src/core/signing/types';
import { fakeAddress } from '../../../src/testing/fake-chain';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { createFakeEnv, type FakeEnv } from '../../../src/testing/env';
import { ctx } from '../signing/fixtures';

/** A cold wallet over `signer`'s key (default: the env's), and its prepared transfer. */
async function prepareCold(env: FakeEnv, signer: Signer = env.signer) {
  const publicKey = await signer.getPublicKey('secp256k1-ecdsa');
  const cold = env.aio
    .scope({ wallets: { cold: { publicKey: toHex(publicKey) } } })
    .blockchain({ chain: 'fakechain', wallet: 'cold' });
  const prepared = await env.run(
    cold.prepareTransfer(
      { to: env.stranger(), amount: 7n },
      { idempotencyKey: 'cold-1' },
    ),
  );
  const signed = await signer.sign(prepared.unsigned?.signingRequests ?? [], ctx);
  if (signed.status !== 'signed') throw new Error('unreachable');
  return { cold, prepared, signatures: signed.signatures };
}

/** The payload the stand-in driver reads: JSON of hex signature bundles. */
const payloadOf = (signatures: readonly SignatureBundle[]): RawTx => ({
  encoding: 'json',
  data: JSON.stringify(signatures.map((s) => ({ ...s, bytes: toHex(s.bytes) }))),
});

/** Gives the pooled fake driver a `signaturesFrom` that records what it was given. */
async function withExtractor(env: FakeEnv, bc: FakeEnv['bc']) {
  const seen: { unsigned: UnsignedTx; signed: RawTx }[] = [];
  const { driver } = await env.run(internalsOf(bc).pooled());
  Object.assign(driver.builder, {
    signaturesFrom: (unsigned: UnsignedTx, signed: RawTx) => {
      seen.push({ unsigned, signed });
      return (
        JSON.parse(signed.data) as {
          requestId: string;
          bytes: string;
          recovery?: number;
        }[]
      ).map((s) => ({ ...s, bytes: fromHex(s.bytes) }));
    },
  });
  return seen;
}

describe('submitSignatures with a signed payload (A6)', () => {
  it('passes the stored unsigned transaction to the driver and submits what it extracts', async () => {
    const env = await createFakeEnv();
    const { cold, prepared, signatures } = await prepareCold(env);
    const seen = await withExtractor(env, cold);
    const sub = await env.run(
      cold.submitSignatures(prepared.operation.id, payloadOf(signatures)),
    );
    expect(sub.state).toBe('submitted');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.unsigned.payload).toEqual(prepared.unsigned?.payload);
  });

  it('verifies every extracted signature against the stored request (R9)', async () => {
    const env = await createFakeEnv();
    const { cold, prepared, signatures } = await prepareCold(env);
    await withExtractor(env, cold);
    const forged = signatures.map((s) => ({ ...s, bytes: new Uint8Array(64).fill(1) }));
    await expect(
      env.run(cold.submitSignatures(prepared.operation.id, payloadOf(forged))),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
    const op = await env.stores.operations.get('default', prepared.operation.id);
    expect(op?.attempts).toHaveLength(0);
  });

  it('refuses a signed payload on a driver that cannot read one, writing nothing', async () => {
    const env = await createFakeEnv();
    const { cold, prepared, signatures } = await prepareCold(env);
    await expect(
      env.run(cold.submitSignatures(prepared.operation.id, payloadOf(signatures))),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const op = await env.stores.operations.get('default', prepared.operation.id);
    expect(op?.state).toBe(prepared.operation.state);
    // Bundles still work on the same Operation.
    const sub = await env.run(cold.submitSignatures(prepared.operation.id, signatures));
    expect(sub.state).toBe('submitted');
  });

  it('refuses a payload that is not { encoding, data } (M8)', async () => {
    const env = await createFakeEnv();
    const { cold, prepared } = await prepareCold(env);
    const seen = await withExtractor(env, cold);
    for (const bad of [{ encoding: 'hex' }, { encoding: 'utf8', data: '00' }, 'abcd']) {
      await expect(
        env.run(cold.submitSignatures(prepared.operation.id, bad as unknown as RawTx)),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    expect(seen).toHaveLength(0);
  });

  it("checks the Operation belongs to the handle's wallet before extracting (M8)", async () => {
    const env = await createFakeEnv();
    const other = localSigner.generate({ curves: ['secp256k1'], id: 'other' }).signer;
    env.chain.fund(fakeAddress(await other.getPublicKey('secp256k1-ecdsa')), 1_000n);
    const { prepared, signatures } = await prepareCold(env, other);
    // env.bc is the main wallet: another address than the cold wallet that prepared it.
    const seen = await withExtractor(env, env.bc);
    await expect(
      env.run(env.bc.submitSignatures(prepared.operation.id, payloadOf(signatures))),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    expect(seen).toHaveLength(0);
  });

  it('fails with NOT_FOUND for an unknown Operation before any extraction', async () => {
    const env = await createFakeEnv();
    const seen = await withExtractor(env, env.bc);
    await expect(
      env.run(env.bc.submitSignatures('op_missing', payloadOf([]))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(seen).toHaveLength(0);
  });

  it("turns a driver's foreign extraction error into INVALID_INTENT, echoing nothing (M10)", async () => {
    const env = await createFakeEnv();
    const { cold, prepared, signatures } = await prepareCold(env);
    const { driver } = await env.run(internalsOf(cold).pooled());
    Object.assign(driver.builder, {
      signaturesFrom: () => {
        throw new Error('Invalid PSBT: cHNidP8BAHECAAAAAf');
      },
    });
    const error = await env
      .run(cold.submitSignatures(prepared.operation.id, payloadOf(signatures)))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the signed payload could not be read',
    });
    expect((error as Error).cause).toBeUndefined();
    // The driver's own classified errors pass through unchanged.
    const own = new ValidationError('INVALID_INTENT', 'not the prepared transaction');
    Object.assign(driver.builder, {
      signaturesFrom: () => {
        throw own;
      },
    });
    await expect(
      env.run(cold.submitSignatures(prepared.operation.id, payloadOf(signatures))),
    ).rejects.toBe(own);
  });
});
