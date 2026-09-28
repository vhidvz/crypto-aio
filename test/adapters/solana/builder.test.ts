import { base58 } from '@scure/base';
import { VersionedMessage } from '@solana/web3.js';
import {
  createSolanaBroadcaster,
  createSolanaBuilder,
} from '../../../src/adapters/solana/builder';
import { variantCounter } from '../../../src/adapters/solana/fees';
import {
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
} from '../../../src/adapters/solana/programs';
import type { SolanaContext } from '../../../src/adapters/solana/reader';
import type {
  SolanaFeeDetails,
  SolanaInstruction,
} from '../../../src/adapters/solana/types';
import { signedTransaction } from '../../../src/adapters/solana/wire';
import type { BuildContext } from '../../../src/core/driver/types';
import { ProviderError } from '../../../src/core/errors/error';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { SignedTx, UnsignedTx } from '../../../src/core/model/transaction';
import { ATA, SYSTEM, TOKEN, TOKEN_2022, associatedAddress } from './support/node';
import { solanaHarness } from './support/harness';
import {
  KEY_ADDRESS,
  KEY_PUBLIC,
  MINT,
  RECIPIENT,
  RECIPIENT_KEY,
  sign,
} from './support/vectors';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

const SPL = { standard: 'spl', contract: MINT };
const SOL = 1_000_000_000n;
const intent = (overrides: Partial<DriverIntent> = {}): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: RECIPIENT, amount: 1_000_000_000n }],
  from: KEY_ADDRESS,
  fee: 'normal',
  ...overrides,
});

function setup(options: { fees?: number[]; fund?: bigint } = {}) {
  const h = solanaHarness({
    node: { prioritizationFees: options.fees ?? [0, 10, 20, 30] },
  });
  h.node.fund(KEY_ADDRESS, options.fund ?? 10_000_000_000n);
  h.node.createMint(MINT, 6);
  h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
  h.node.produce(2);
  const build: BuildContext = { from: KEY_ADDRESS, keys: h.keys, wallet: {} };
  return {
    ...h,
    build,
    builder: createSolanaBuilder(h.ctx),
    broadcaster: createSolanaBroadcaster(h.ctx),
  };
}

type Setup = ReturnType<typeof setup>;

async function signedFor(h: Setup, request: DriverIntent) {
  const fee = await h.run(h.builder.estimateFee(request, h.build));
  const unsigned = await h.run(h.builder.build(request, fee, h.build));
  const signature = sign(unsigned.signingRequests[0]!.payload);
  return {
    fee,
    unsigned,
    signed: await h.run(
      h.builder.assemble(unsigned, [{ requestId: 's0', bytes: signature }]),
    ),
  };
}

describe('Solana fee estimates', () => {
  it('prices a native transfer from the node: signature fee, simulated limit, percentile price', async () => {
    const h = setup();
    h.calls.length = 0;
    const fee = await h.run(h.builder.estimateFee(intent(), h.build));
    // Simulated: 150 + 150 + 150 units; limit = 450 + 90 + 1,000; normal = the 50th percentile (10).
    expect(fee).toEqual({
      kind: 'solana',
      speed: 'normal',
      bound: 'exact',
      charges: [
        { asset: 'native', amount: 5_000n, label: 'network' },
        { asset: 'native', amount: 1n, label: 'priority' },
      ],
      details: {
        signatures: 1,
        baseFee: 5_000n,
        computeUnitLimit: 1_540n,
        computeUnitPrice: 10n,
        priorityFee: 1n,
        rent: 0n,
        createsRecipientAccount: false,
      },
    });
    expect(
      h.calls.every((c) => c.tags.purpose === 'read' && c.tags.retry === 'safe'),
    ).toBe(true);
    expect(h.calls.map((c) => c.method)).toEqual([
      'getAccountInfo',
      'getMinimumBalanceForRentExemption',
      'getRecentPrioritizationFees',
      'getLatestBlockhash',
      'simulateTransaction',
      'getFeeForMessage',
    ]);
  });

  it('charges the rent of a missing recipient token account as an upper bound', async () => {
    const h = setup();
    const missing = await h.run(
      h.builder.estimateFee(
        intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
        h.build,
      ),
    );
    expect(missing).toMatchObject({
      bound: 'upper',
      details: { createsRecipientAccount: true, rent: 1_488_440n },
    });
    expect(missing.charges.map((c) => c.label)).toEqual(['network', 'priority', 'rent']);
    h.node.mintTo(MINT, RECIPIENT, 0n);
    const existing = await h.run(
      h.builder.estimateFee(
        intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
        h.build,
      ),
    );
    expect(existing).toMatchObject({
      bound: 'exact',
      details: { createsRecipientAccount: false, rent: 0n },
    });
  });

  it("honours an explicit price exactly, and varies every build's limit (D10, M3)", async () => {
    const h = setup();
    const custom = await h.run(
      h.builder.estimateFee(
        intent({ fee: { computeUnitPrice: 2_000_000n, computeUnitLimit: 20_000n } }),
        h.build,
      ),
    );
    expect(custom).toMatchObject({
      speed: 'custom',
      details: {
        computeUnitPrice: 2_000_000n,
        computeUnitLimit: 20_000n,
        priorityFee: 40_000n,
      },
    });
    const varied: SolanaContext = {
      ...h.ctx,
      nextVariant: variantCounter(1_024 * 7 + 3),
    };
    const fee = await h.run(createSolanaBuilder(varied).estimateFee(intent(), h.build));
    expect(fee.details).toMatchObject({
      computeUnitLimit: 1_543n,
      computeUnitPrice: 17n,
    });
    // An explicit limit gets the variant too, so identical overrides differ; its price not.
    const explicit = await h.run(
      createSolanaBuilder(varied).estimateFee(
        intent({ fee: { computeUnitPrice: 2_000_000n, computeUnitLimit: 20_000n } }),
        h.build,
      ),
    );
    expect(explicit.details).toMatchObject({
      computeUnitPrice: 2_000_000n,
      computeUnitLimit: 20_004n,
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ fee: { gasPrice: 1n } }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });
});

describe('refusals before signing (Review Focus 4)', () => {
  it('refuses recipients that would lose the funds', async () => {
    const h = setup();
    h.node.setAccount(RECIPIENT, {
      owner: 'Stake11111111111111111111111111111111111111',
      data: new Uint8Array(200),
    });
    await expect(h.run(h.builder.estimateFee(intent(), h.build))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a program-owned account',
    });
    // M4: SPL to a program id, whose token account nobody could ever sign for.
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({
            asset: SPL,
            outputs: [{ to: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', amount: 1n }],
          }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a program; send to a wallet or a PDA owner',
    });
    const tokenAccount = associatedAddress(KEY_ADDRESS, MINT);
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: tokenAccount, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: SPL, outputs: [{ to: tokenAccount, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a token account; send to its owner',
    });
    const fresh = base58.encode(ed25519.getPublicKey(RECIPIENT_KEY.replace('8b', '8c')));
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: fresh, amount: 650_239n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: fresh, amount: 650_240n }] }),
          h.build,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'solana',
    });
  });

  it('refuses frozen accounts, Token-2022 mints, bad memos, several outputs and a foreign key', async () => {
    const h = setup();
    h.node.mintTo(MINT, RECIPIENT, 0n, { frozen: true });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient token account is frozen',
    });
    const t22 = 'So11111111111111111111111111111111111111112';
    h.node.createMint(t22, 9, TOKEN_2022);
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: { standard: 'spl', contract: t22 } }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'x'.repeat(257) }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'a\uD800b' }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'é'.repeat(128) }), h.build)),
    ).resolves.toBeDefined();
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({
            outputs: [
              { to: RECIPIENT, amount: 1n },
              { to: RECIPIENT, amount: 2n },
            ],
          }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // A fee needs no key; building for an address the wallet has no key for does.
    h.node.fund(RECIPIENT, 10_000_000_000n);
    const theirs = intent({
      from: RECIPIENT,
      outputs: [{ to: KEY_ADDRESS, amount: SOL }],
    });
    const fee = await h.run(h.builder.estimateFee(theirs, { ...h.build, keys: [] }));
    await expect(
      h.run(h.builder.build(theirs, fee, { ...h.build, from: RECIPIENT })),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
  });
});

describe('funds checks (Review Focus 4)', () => {
  it('keeps the sender at zero or above the rent-exempt minimum', async () => {
    const h = setup({ fund: 2_000_000n });
    const fee = await h.run(
      h.builder.estimateFee(
        intent({ outputs: [{ to: RECIPIENT, amount: 1_500_000n }] }),
        h.build,
      ),
    );
    // 2,000,000 − 1,500,000 − fees would leave about 495,000: below the 650,240 minimum.
    const spent = 1_500_000n + fee.charges.reduce((s, c) => s + c.amount, 0n);
    const available = 2_000_000n;
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: 1_500_000n }] }),
          fee,
          h.build,
        ),
      ),
    ).toEqual({ ok: false, asset: 'native', required: spent + 650_240n, available });
    const sweep = available - fee.charges.reduce((s, c) => s + c.amount, 0n);
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: sweep }] }),
          fee,
          h.build,
        ),
      ),
    ).toEqual({
      ok: true,
    });
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: 3_000_000n }] }),
          fee,
          h.build,
        ),
      ),
    ).toMatchObject({ ok: false, asset: 'native', available });
  });

  it('checks the token balance of the source account and the lamports for fees', async () => {
    const h = setup();
    const request = intent({
      asset: SPL,
      outputs: [{ to: RECIPIENT, amount: 6_000_000n }],
    });
    const fee = await h.run(h.builder.estimateFee(request, h.build));
    expect(await h.run(h.builder.checkFunds(request, fee, h.build))).toEqual({
      ok: false,
      asset: SPL,
      required: 6_000_000n,
      available: 5_000_000n,
    });
    h.node.mintTo(MINT, KEY_ADDRESS, 0n, { frozen: true });
    await expect(
      h.run(h.builder.checkFunds(request, fee, h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the source token account is frozen',
    });
  });
});

describe('building and assembling', () => {
  it('builds a legacy message with the estimate, an expiry ordering and one ed25519 request', async () => {
    const h = setup();
    const request = intent({
      asset: SPL,
      outputs: [{ to: RECIPIENT, amount: 2_000_000n }],
      memo: 'order-7',
    });
    const { fee, unsigned, signed } = await signedFor(h, request);
    // F5-R9: the height comes with the blockhash and the slot of its block.
    expect(unsigned.ordering).toEqual({
      kind: 'expiry',
      lastValidHeight: h.node.head.height + 150n,
      blockhash: h.node.head.hash,
      blockhashSlot: h.node.head.slot,
    });
    expect(unsigned.signingRequests).toEqual([
      {
        id: 's0',
        scheme: 'ed25519',
        payload: expect.any(Uint8Array),
        payloadKind: 'message',
        publicKey: h.keys[0]!.publicKey,
      },
    ]);
    expect(unsigned.summary).toEqual({
      asset: `solana:devnet/spl:${MINT}`,
      outputs: [{ to: RECIPIENT, amount: '2000000' }],
      memo: 'order-7',
    });
    expect(unsigned.fee).toBe(fee);
    const message = VersionedMessage.deserialize(
      Buffer.from(unsigned.payload.data, 'base64'),
    );
    const programs = message.compiledInstructions.map((ix) =>
      message.staticAccountKeys[ix.programIdIndex]!.toBase58(),
    );
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      TOKEN,
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ]);
    expect(message.recentBlockhash).toBe(h.node.head.hash);
    expect(signed.ref).toEqual({
      id: base58.encode(sign(unsigned.signingRequests[0]!.payload)),
      idKind: 'signature',
      canonical: true,
    });
    expect(signed.raw.encoding).toBe('base64');
  });

  it('gives two identical Operations different bytes (identical-transfer hazard)', async () => {
    const h = setup();
    const ctx: SolanaContext = { ...h.ctx, nextVariant: variantCounter(0) };
    const builder = createSolanaBuilder(ctx);
    const payloads = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const fee = await h.run(builder.estimateFee(intent(), h.build));
      payloads.add((await h.run(builder.build(intent(), fee, h.build))).payload.data);
    }
    expect(payloads.size).toBe(3);
  });

  it('refuses to assemble with a missing or foreign signature request', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(intent(), h.build));
    const unsigned = await h.run(h.builder.build(intent(), fee, h.build));
    await expect(h.run(h.builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    await expect(
      h.run(
        h.builder.assemble(unsigned, [{ requestId: 's0', bytes: new Uint8Array(63) }]),
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    const foreign = {
      ...unsigned,
      signingRequests: [
        {
          ...unsigned.signingRequests[0]!,
          publicKey: ed25519.getPublicKey(RECIPIENT_KEY),
        },
      ],
    };
    await expect(
      h.run(
        h.builder.assemble(foreign, [{ requestId: 's0', bytes: new Uint8Array(64) }]),
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
  });
});

describe('the Solana broadcaster', () => {
  it('sends with preflight at confirmed and classifies the answers', async () => {
    const h = setup();
    const { signed } = await signedFor(h, intent());
    h.calls.length = 0;
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    expect(h.calls).toEqual([
      {
        method: 'sendTransaction',
        tags: { purpose: 'broadcast', retry: 'ambiguous-on-failure' },
        params: [
          signed.raw.data,
          { encoding: 'base64', preflightCommitment: 'confirmed' },
        ],
      },
    ]);
    h.node.produce(1);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    const hex = {
      ...signed,
      raw: {
        encoding: 'hex' as const,
        data: Buffer.from(signed.raw.data, 'base64').toString('hex'),
      },
    };
    expect(await h.run(h.broadcaster.broadcast(hex))).toEqual({ kind: 'already-known' });
    const forged = Buffer.from(signed.raw.data, 'base64');
    forged[5] = (forged[5] as number) ^ 1;
    expect(
      await h.run(
        h.broadcaster.broadcast({
          ...signed,
          raw: { encoding: 'base64', data: forged.toString('base64') },
        }),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid signature' });
    await expect(
      h.run(
        h.broadcaster.broadcast({ ...signed, raw: { encoding: 'json', data: '{}' } }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });

  it('refuses a signature failure a node claims for our valid bytes (lesson 21, F5-R15)', async () => {
    const h = setup();
    const { signed } = await signedFor(h, intent());
    const text =
      'Transaction simulation failed: Transaction did not pass signature verification';
    const simulation = { err: 'SignatureFailure', logs: [], accounts: null };
    // A lone endpoint that relays nothing and claims a bad signature, in each of its forms.
    const claims = [
      { code: -32002, message: text, data: simulation },
      { code: -32002, message: text },
      { code: -32003, message: 'Transaction signature verification failure' },
    ];
    for (const error of claims) {
      h.node.intercept = (_endpoint, method) =>
        method === 'sendTransaction' ? { error } : undefined;
      expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'the node claimed an invalid signature',
      });
    }
    // The same claims for bytes whose signature is genuinely bad stand.
    const forged = Buffer.from(signed.raw.data, 'base64');
    forged[5] = (forged[5] as number) ^ 1;
    const bad = {
      ...signed,
      raw: { encoding: 'base64' as const, data: forged.toString('base64') },
    };
    for (const error of claims) {
      h.node.intercept = (_endpoint, method) =>
        method === 'sendTransaction' ? { error } : undefined;
      expect(await h.run(h.broadcaster.broadcast(bad))).toEqual({
        kind: 'rejected',
        reason: 'invalid signature',
      });
    }
    h.node.intercept = undefined;
    expect(h.node.sendCount(signed.ref.id)).toBe(0);
    // The node itself, honest, still takes our bytes.
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
  });

  it('passes fanout and signal through, and rethrows every unclassified failure unchanged', async () => {
    const seen: unknown[] = [];
    const stub = (error: unknown): SolanaContext =>
      ({
        ...solanaHarness().ctx,
        transport: {
          rpc: (_m: string, _p: unknown, options: unknown) => {
            seen.push(options);
            return Promise.reject(error);
          },
        },
      }) as unknown as SolanaContext;
    const signed = {
      raw: { encoding: 'base64' as const, data: 'AA==' },
      ref: { id: '', idKind: 'signature' as const, canonical: true },
    };
    const failures = [
      new ProviderError('RPC_ERROR', 'x', {
        details: { rpcCode: -32002, rpcMessage: 'x' },
        ambiguous: true,
      }),
      new ProviderError('PROVIDER_UNAVAILABLE', 'timeout', { ambiguous: true }),
      new Error('foreign'),
    ];
    const signal = new AbortController().signal;
    for (const error of failures) {
      await expect(
        createSolanaBroadcaster(stub(error)).broadcast(signed, { fanout: 2, signal }),
      ).rejects.toBe(error);
    }
    expect(seen[0]).toMatchObject({
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
      fanout: 2,
      signal,
    });
  });
});

// ---- Beyond the brief: what the Task 1–6 reviews carry into the builder ----------------

const u64Hex = (value: bigint): string => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out.toString('hex');
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** A built payload's instructions, decoded by the SDK (not by the driver's own parser). */
function instructionsOf(unsigned: UnsignedTx) {
  const message = VersionedMessage.deserialize(
    Buffer.from(unsigned.payload.data, 'base64'),
  );
  const key = (i: number) => message.staticAccountKeys[i]!.toBase58();
  return message.compiledInstructions.map((ix) => ({
    program: key(ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map(key),
    data: Buffer.from(ix.data).toString('hex'),
  }));
}

/** A context whose codec compiles `edit(list)` (on `blockhash`, when given) instead. */
function compiling(
  ctx: SolanaContext,
  edit: (list: readonly SolanaInstruction[]) => readonly SolanaInstruction[],
  options: { readonly blockhash?: string; readonly payer?: string } = {},
): SolanaContext {
  const { codec } = ctx;
  return {
    ...ctx,
    codec: {
      ...codec,
      compileMessage: (payer, hash, list) =>
        codec.compileMessage(
          options.payer ?? payer,
          options.blockhash ?? hash,
          edit(list),
        ),
    },
  };
}

/** Appends `extra` distinct, unused read-only keys: a longer message that stays valid. */
function withUnusedKeys(message: Uint8Array, extra: number): Uint8Array {
  const count = message[3] as number; // below 128 here: a one-byte compact-u16
  const end = 4 + 32 * count;
  const keys = Array.from({ length: extra }, (_, i) => [...sha256(Uint8Array.of(i))]);
  return Uint8Array.from([
    message[0] as number,
    message[1] as number,
    (message[2] as number) + extra,
    count + extra,
    ...message.subarray(4, end),
    ...keys.flat(),
    ...message.subarray(end),
  ]);
}

/** A context whose messages carry `extra` unused keys (`withUnusedKeys`). */
const padded = (ctx: SolanaContext, extra: number): SolanaContext => ({
  ...ctx,
  codec: {
    ...ctx.codec,
    compileMessage: (payer, hash, list) =>
      withUnusedKeys(ctx.codec.compileMessage(payer, hash, list), extra),
  },
});

/** A classic token account's 165 bytes: mint, owner, amount, initialized. */
function tokenAccountBytes(mint: string, owner: string, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(base58.decode(mint), 0);
  data.set(base58.decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
}

const STRANGER = base58.encode(ed25519.getPublicKey(RECIPIENT_KEY.replace('8b', '8c')));
const bare = (raw: SignedTx['raw']): SignedTx => ({
  raw,
  ref: { id: '', idKind: 'signature', canonical: true },
});

describe('the recipient binding (the landing guard trusts it)', () => {
  it("signs transfers that pay the intent's recipient: SOL to it, SPL to its token account", async () => {
    const h = setup();
    const native = await signedFor(
      h,
      intent({ outputs: [{ to: RECIPIENT, amount: 3n * SOL }] }),
    );
    expect(instructionsOf(native.unsigned)[2]).toEqual({
      program: SYSTEM,
      accounts: [KEY_ADDRESS, RECIPIENT],
      data: `02000000${u64Hex(3n * SOL)}`,
    });
    const spl = await signedFor(
      h,
      intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 2_000_000n }] }),
    );
    // Derived here from the recipient, the mint and the mint's own program (classic Token).
    const theirs = associatedAddress(RECIPIENT, MINT, TOKEN);
    expect(instructionsOf(spl.unsigned).slice(2)).toEqual([
      {
        program: ATA,
        accounts: [KEY_ADDRESS, theirs, RECIPIENT, MINT, SYSTEM, TOKEN],
        data: '01',
      },
      {
        program: TOKEN,
        accounts: [
          associatedAddress(KEY_ADDRESS, MINT, TOKEN),
          MINT,
          theirs,
          KEY_ADDRESS,
        ],
        data: `0c${u64Hex(2_000_000n)}06`,
      },
    ]);
    for (const { signed } of [native, spl]) {
      expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    }
    h.node.produce(1);
    expect(h.node.balance(RECIPIENT)).toBe(3n * SOL);
    expect(h.node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
  });

  it('refuses, before anything is signed, a compiled message that pays or signs otherwise', async () => {
    const h = setup();
    const spl = intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 2_000_000n }] });
    const native = intent();
    const splFee = await h.run(h.builder.estimateFee(spl, h.build));
    const nativeFee = await h.run(h.builder.estimateFee(native, h.build));
    const build = (ctx: SolanaContext, request: DriverIntent) =>
      h.run(
        createSolanaBuilder(ctx).build(
          request,
          request === spl ? splFee : nativeFee,
          h.build,
        ),
      );
    const refused = (message: string) => ({ code: 'INVALID_INTENT', message });
    const PAYS_ELSEWHERE = refused('the transfer does not pay the recipient');
    const MISMATCH = refused('the compiled message does not match the transfer');
    const SIGNERS = refused('the compiled message has unexpected signers');
    // Another token account or amount, a second transfer, or none: the binding refuses.
    const retarget = compiling(h.ctx, (list) =>
      list.map((ix) =>
        ix.programId === TOKEN
          ? {
              ...ix,
              accounts: ix.accounts.map((a, i) =>
                i === 2 ? { ...a, address: associatedAddress(STRANGER, MINT) } : a,
              ),
            }
          : ix,
      ),
    );
    await expect(build(retarget, spl)).rejects.toMatchObject(PAYS_ELSEWHERE);
    const amount = compiling(h.ctx, (list) =>
      list.map((ix) =>
        ix.programId === SYSTEM ? systemTransfer(KEY_ADDRESS, RECIPIENT, 1n) : ix,
      ),
    );
    await expect(build(amount, native)).rejects.toMatchObject(PAYS_ELSEWHERE);
    const second = compiling(h.ctx, (list) => [
      ...list,
      systemTransfer(KEY_ADDRESS, STRANGER, 1n),
    ]);
    await expect(build(second, native)).rejects.toMatchObject(PAYS_ELSEWHERE);
    const dropped = compiling(h.ctx, (list) => list.slice(0, -1));
    await expect(build(dropped, spl)).rejects.toMatchObject(PAYS_ELSEWHERE);
    // Anything else that differs from the list built: the blockhash, an extra or changed
    // instruction, or a destination the message does not let the transfer write.
    const stale = compiling(h.ctx, (list) => list, { blockhash: h.node.block(0n)!.hash });
    await expect(build(stale, native)).rejects.toMatchObject(MISMATCH);
    const extra = compiling(h.ctx, (list) => [...list, memo('x')]);
    await expect(build(extra, native)).rejects.toMatchObject(MISMATCH);
    const repriced = compiling(h.ctx, (list) => [
      list[0]!,
      setComputeUnitPrice(10n ** 9n),
      ...list.slice(2),
    ]);
    await expect(build(repriced, spl)).rejects.toMatchObject(MISMATCH);
    const readOnly = compiling(h.ctx, (list) =>
      list.map((ix) =>
        ix.programId === SYSTEM
          ? {
              ...ix,
              accounts: ix.accounts.map((a, i) =>
                i === 1 ? { ...a, writable: false } : a,
              ),
            }
          : ix,
      ),
    );
    await expect(build(readOnly, native)).rejects.toMatchObject(MISMATCH);
    // Another signer, or another fee payer.
    const cosigned = compiling(h.ctx, (list) =>
      list.map((ix) =>
        ix.programId === SYSTEM
          ? {
              ...ix,
              accounts: [
                ...ix.accounts,
                { address: RECIPIENT, signer: true, writable: false },
              ],
            }
          : ix,
      ),
    );
    await expect(build(cosigned, native)).rejects.toMatchObject(SIGNERS);
    const payer = compiling(h.ctx, (list) => list, { payer: RECIPIENT });
    await expect(build(payer, native)).rejects.toMatchObject(SIGNERS);
    // One signer still, but a stranger's: the sender signs nothing and pays nothing.
    const strangerPays = compiling(
      h.ctx,
      (list) =>
        list.map((ix) => ({
          ...ix,
          accounts: ix.accounts.map((a) => ({ ...a, signer: false })),
        })),
      { payer: STRANGER },
    );
    await expect(build(strangerPays, native)).rejects.toMatchObject(SIGNERS);
    // A null from the message reader is a refusal, never "no signers needed".
    const versioned: SolanaContext = {
      ...h.ctx,
      codec: {
        ...h.ctx.codec,
        compileMessage: (payer_, hash, list) =>
          Uint8Array.from([0x80, ...h.ctx.codec.compileMessage(payer_, hash, list)]),
      },
    };
    await expect(build(versioned, native)).rejects.toMatchObject(
      refused('the compiled message is not one legacy message'),
    );
  });
});

describe('assembling exactly what the header requires', () => {
  it('assembles one signature per required signer, from a canonical payload only', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(intent(), h.build));
    const unsigned = await h.run(h.builder.build(intent(), fee, h.build));
    const request = unsigned.signingRequests[0]!;
    const own = { requestId: 's0', bytes: sign(request.payload) };
    const assemble = (u: UnsignedTx, signatures = [own]) =>
      h.run(h.builder.assemble(u, signatures));
    const over = (
      message: Uint8Array,
      requests = [{ ...request, payload: message }],
    ) => ({
      ...unsigned,
      payload: { encoding: 'base64' as const, data: b64(message) },
      signingRequests: requests,
    });
    const FAILED = { code: 'SIGNING_FAILED' };
    // Not one legacy message.
    await expect(
      assemble(over(Uint8Array.from([0x80, ...request.payload]))),
    ).rejects.toMatchObject(FAILED);
    // Two signers required, one request; and two requests for one signer.
    const two = h.ctx.codec.compileMessage(KEY_ADDRESS, h.node.head.hash, [
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1n),
      systemTransfer(RECIPIENT, KEY_ADDRESS, 1n),
    ]);
    await expect(assemble(over(two))).rejects.toMatchObject(FAILED);
    const second = {
      ...request,
      id: 's1',
      publicKey: ed25519.getPublicKey(RECIPIENT_KEY),
    };
    await expect(
      assemble(
        over(request.payload, [request, { ...second, payload: request.payload }]),
        [own, { requestId: 's1', bytes: sign(request.payload, RECIPIENT_KEY) }],
      ),
    ).rejects.toMatchObject(FAILED);
    // Both signers of a two-signer message: two signatures, in the header's order.
    const both = await assemble(
      over(two, [
        { ...request, payload: two },
        { ...second, payload: two },
      ]),
      [
        { requestId: 's1', bytes: sign(two, RECIPIENT_KEY) },
        { requestId: 's0', bytes: sign(two) },
      ],
    );
    const raw = Buffer.from(both.raw.data, 'base64');
    expect(raw[0]).toBe(2);
    expect(Buffer.from(raw.subarray(1, 65))).toEqual(Buffer.from(sign(two)));
    // The stored payload must be the message's canonical base64, and nothing else.
    await expect(
      assemble({
        ...unsigned,
        payload: { encoding: 'base64', data: `${unsigned.payload.data}\n` },
      }),
    ).rejects.toMatchObject(FAILED);
    await expect(
      assemble({ ...unsigned, payload: { encoding: 'hex', data: 'aa' } }),
    ).rejects.toMatchObject(FAILED);
    await expect(
      assemble({
        ...unsigned,
        signingRequests: [{ ...request, scheme: 'secp256k1-ecdsa' }],
      }),
    ).rejects.toMatchObject(FAILED);
    await expect(
      assemble({
        ...unsigned,
        signingRequests: [{ ...request, payloadKind: 'digest' }],
      }),
    ).rejects.toMatchObject(FAILED);
    await expect(assemble(unsigned)).resolves.toMatchObject({
      ref: { id: base58.encode(own.bytes) },
    });
  });

  it('signs with the key of the sending address, and names its key reference', async () => {
    const h = setup();
    const keyRef = { id: 'hot', path: "m/44'/501'/0'/0'" };
    const build: BuildContext = {
      ...h.build,
      keys: [
        { scheme: 'ed25519', publicKey: ed25519.getPublicKey(RECIPIENT_KEY) },
        { scheme: 'ed25519', publicKey: KEY_PUBLIC, keyRef },
      ],
    };
    const fee = await h.run(h.builder.estimateFee(intent(), build));
    const unsigned = await h.run(h.builder.build(intent(), fee, build));
    expect(unsigned.signingRequests).toEqual([
      expect.objectContaining({ publicKey: KEY_PUBLIC, keyRef }),
    ]);
  });
});

describe('the packet limit: 1,232 bytes (1,644 base64 characters)', () => {
  /** Unused keys that bring a native transfer with a memo near the limit (`padded`). */
  const EXTRA_KEYS = 25;
  /** A native transfer whose signed bytes are `size` long under `padded(ctx, EXTRA_KEYS)`. */
  const sized = (size: number) => intent({ memo: 'm'.repeat(size - 1_232 + 129) });
  const TOO_LARGE = {
    code: 'INVALID_INTENT',
    message: 'the transaction exceeds 1232 bytes',
  };

  it('builds 1,232 bytes, which the node takes, and refuses 1,233 before anything is sent', async () => {
    const h = setup();
    const big = createSolanaBuilder(padded(h.ctx, EXTRA_KEYS));
    const fee = await h.run(big.estimateFee(sized(1_232), h.build));
    const unsigned = await h.run(big.build(sized(1_232), fee, h.build));
    const signed = await h.run(
      big.assemble(unsigned, [
        { requestId: 's0', bytes: sign(unsigned.signingRequests[0]!.payload) },
      ]),
    );
    expect(Buffer.from(signed.raw.data, 'base64')).toHaveLength(1_232);
    expect(signed.raw.data).toHaveLength(1_644);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    h.node.produce(1);
    expect(h.node.landed(signed.ref.id)?.err).toBeNull();
    // One byte more: refused before the simulation (or, with an explicit fee, the quote).
    h.calls.length = 0;
    await expect(h.run(big.estimateFee(sized(1_233), h.build))).rejects.toMatchObject(
      TOO_LARGE,
    );
    const explicit = intent({
      ...sized(1_233),
      fee: { computeUnitPrice: 1n, computeUnitLimit: 50_000n },
    });
    await expect(h.run(big.estimateFee(explicit, h.build))).rejects.toMatchObject(
      TOO_LARGE,
    );
    expect(h.calls.map((c) => c.method)).not.toContain('simulateTransaction');
    expect(h.calls.map((c) => c.method)).not.toContain('getFeeForMessage');
    const plain = await h.run(h.builder.estimateFee(sized(1_233), h.build));
    await expect(h.run(big.build(sized(1_233), plain, h.build))).rejects.toMatchObject(
      TOO_LARGE,
    );
  });

  it('assembles at most 1,232 bytes, and broadcasts no more, as the node refuses them', async () => {
    const h = setup();
    const request = sized(1_233);
    const fee = await h.run(h.builder.estimateFee(request, h.build));
    const unsigned = await h.run(h.builder.build(request, fee, h.build));
    const details = fee.details as unknown as SolanaFeeDetails;
    const message = withUnusedKeys(
      h.ctx.codec.compileMessage(KEY_ADDRESS, h.node.head.hash, [
        setComputeUnitLimit(details.computeUnitLimit),
        setComputeUnitPrice(details.computeUnitPrice),
        systemTransfer(KEY_ADDRESS, RECIPIENT, SOL),
        memo(request.memo!),
      ]),
      EXTRA_KEYS,
    );
    const raw = signedTransaction([sign(message)], message);
    expect(raw).toHaveLength(1_233);
    await expect(
      h.run(
        h.builder.assemble(
          {
            ...unsigned,
            payload: { encoding: 'base64', data: b64(message) },
            signingRequests: [{ ...unsigned.signingRequests[0]!, payload: message }],
          },
          [{ requestId: 's0', bytes: sign(message) }],
        ),
      ),
    ).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
      message: 'the transaction exceeds 1232 bytes',
    });
    // 1,233 bytes still fit 1,644 characters, so the bytes decide; longer text is refused
    // before it is decoded (lesson 20). Nothing reaches the node.
    expect(b64(raw)).toHaveLength(1_644);
    const refused = {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'transaction too large',
    };
    h.calls.length = 0;
    for (const signed of [
      bare({ encoding: 'base64', data: b64(raw) }),
      bare({ encoding: 'hex', data: Buffer.from(raw).toString('hex') }),
      bare({ encoding: 'base64', data: 'A'.repeat(1_645) }),
      bare({ encoding: 'base64', data: 'A'.repeat(100_000) }),
      bare({ encoding: 'hex', data: 'a'.repeat(2_465) }),
    ]) {
      expect(await h.run(h.broadcaster.broadcast(signed))).toEqual(refused);
    }
    expect(h.calls).toEqual([]);
    // The node refuses the same bytes with agave's -32602.
    expect(() => h.node.submit(b64(raw))).toThrow(/too large: 1233 bytes \(max: 1232/);
  });

  it('sends only well-formed bytes: a malformed text is refused and never sent', async () => {
    const h = setup();
    const { signed } = await signedFor(h, intent());
    const hex = Buffer.from(signed.raw.data, 'base64').toString('hex');
    h.calls.length = 0;
    for (const raw of [
      { encoding: 'hex' as const, data: 'abc' },
      { encoding: 'hex' as const, data: 'zz' },
      { encoding: 'hex' as const, data: `${hex}zz` },
      { encoding: 'base64' as const, data: 'AAA' },
      { encoding: 'base64' as const, data: `${signed.raw.data}\n` },
      { encoding: 'base64' as const, data: '!!!!' },
    ]) {
      await expect(h.run(h.broadcaster.broadcast(bare(raw)))).rejects.toMatchObject({
        code: 'INVALID_INTENT',
      });
    }
    expect(h.calls).toEqual([]);
    // The same bytes in upper-case hex are the same transaction.
    expect(
      await h.run(
        h.broadcaster.broadcast(bare({ encoding: 'hex', data: hex.toUpperCase() })),
      ),
    ).toEqual({ kind: 'accepted' });
    expect(h.calls[0]!.params).toEqual([
      signed.raw.data,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
  });
});

describe('broadcast classification reads the structured error first (Task 2 A2)', () => {
  it("classifies a preflight failure by its data, which only narrows 'rejected'", async () => {
    const h = setup();
    const { signed } = await signedFor(h, intent());
    const answer = (message: string, err: unknown) => {
      h.node.intercept = (_endpoint, method) =>
        method === 'sendTransaction'
          ? { error: { code: -32002, message, data: { err, logs: [] } } }
          : undefined;
    };
    answer(
      'Transaction simulation failed: the payer cannot pay the fee',
      'InsufficientFundsForFee',
    );
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'refused',
      code: 'INSUFFICIENT_FUNDS',
      reason: 'insufficient funds for fee',
    });
    answer('Transaction simulation failed: seen before', 'AlreadyProcessed');
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    answer(
      'Transaction simulation failed: Transaction did not pass signature verification',
      'BlockhashNotFound',
    );
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'blockhash not found',
    });
  });
});

describe('fees that have no u64 value', () => {
  it('refuses an explicit price whose fee does not fit, and quotes one that does', async () => {
    const h = setup();
    const max = 2n ** 64n - 1n;
    const priced = (computeUnitPrice: bigint, computeUnitLimit: bigint) =>
      h.run(
        h.builder.estimateFee(
          intent({ fee: { computeUnitPrice, computeUnitLimit } }),
          h.build,
        ),
      );
    const NO_FIT = {
      code: 'INVALID_INTENT',
      message: 'Solana fee override: the fee does not fit in u64',
    };
    // A priority fee beyond u64 is refused before the node is asked for a quote.
    h.calls.length = 0;
    await expect(priced(max, 1_400_000n)).rejects.toMatchObject(NO_FIT);
    expect(h.calls.map((c) => c.method)).not.toContain('getFeeForMessage');
    // The node's quote saturates at u64::MAX: base fee plus a priority fee of u64::MAX − 5,000.
    await expect(priced(max - 5_000n, 1_000_000n)).rejects.toMatchObject(NO_FIT);
    await expect(priced(max - 5_001n, 1_000_000n)).resolves.toMatchObject({
      details: { baseFee: 5_000n, priorityFee: max - 5_001n },
    });
  });

  it("reads a node's saturated or short quote for a speed as malformed, never a fee", async () => {
    const h = setup();
    for (const value of [2n ** 64n - 1n, 0n]) {
      h.node.intercept = (_endpoint, method) =>
        method === 'getFeeForMessage'
          ? { result: { context: { slot: 1 }, value } }
          : undefined;
      await expect(h.run(h.builder.estimateFee(intent(), h.build))).rejects.toMatchObject(
        {
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          message: 'malformed getFeeForMessage answer',
        },
      );
    }
  });
});

describe("the caller's signal", () => {
  it('rides on every read of the builder (the contract table)', async () => {
    const h = setup();
    const request = intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] });
    const fee = await h.run(h.builder.estimateFee(request, h.build));
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    const stopped: BuildContext = { ...h.build, signal: controller.signal };
    h.node.served.length = 0;
    await expect(h.run(h.builder.estimateFee(request, stopped))).rejects.toBe(reason);
    await expect(h.run(h.builder.checkFunds(request, fee, stopped))).rejects.toBe(reason);
    await expect(h.run(h.builder.build(request, fee, stopped))).rejects.toBe(reason);
    expect(h.node.served).toEqual([]);
  });
});

describe('token accounts at their associated addresses', () => {
  it('creates the recipient token account even where its address already holds lamports', async () => {
    const h = setup();
    const theirs = associatedAddress(RECIPIENT, MINT);
    // Anyone can fund the address first; the ATA program keeps those lamports.
    h.node.setAccount(theirs, { lamports: 1_000n });
    const request = intent({
      asset: SPL,
      outputs: [{ to: RECIPIENT, amount: 2_000_000n }],
    });
    const { fee, signed } = await signedFor(h, request);
    expect(fee).toMatchObject({
      bound: 'upper',
      details: { createsRecipientAccount: true, rent: 1_488_440n },
    });
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    h.node.produce(1);
    expect(h.node.landed(signed.ref.id)?.err).toBeNull();
    expect(h.node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
    // Any other account there is not the recipient's token account.
    const other = setup();
    other.node.setAccount(theirs, {
      owner: 'Stake11111111111111111111111111111111111111',
      data: new Uint8Array(200),
    });
    await expect(
      other.run(other.builder.estimateFee(request, other.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient token account does not match',
    });
  });

  it("spends only the sender's own token account at its associated address", async () => {
    const h = setup();
    const ours = associatedAddress(KEY_ADDRESS, MINT);
    const request = intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1_000n }] });
    const fee = await h.run(h.builder.estimateFee(request, h.build));
    // Its owner was reassigned (SetAuthority): the sender cannot sign for it any more.
    h.node.setAccount(ours, {
      owner: TOKEN,
      lamports: h.node.rent(165),
      data: tokenAccountBytes(MINT, RECIPIENT, 5_000_000n),
    });
    await expect(
      h.run(h.builder.checkFunds(request, fee, h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the source token account does not match',
    });
    // An address that only holds lamports holds no tokens.
    h.node.setAccount(ours, { lamports: 1_000n });
    expect(await h.run(h.builder.checkFunds(request, fee, h.build))).toEqual({
      ok: false,
      asset: SPL,
      required: 1_000n,
      available: 0n,
    });
  });
});
