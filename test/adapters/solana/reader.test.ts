import {
  accountInfo,
  createSolanaAddressCodec,
  createSolanaExt,
  createSolanaReader,
  type SolanaContext,
} from '../../../src/adapters/solana/reader';
import {
  createAssociatedTokenAccountIdempotent,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { ProviderError } from '../../../src/core/errors/error';
import { TOKEN, TOKEN_2022, associatedAddress } from './support/node';
import { solanaHarness, type Endpoint } from './support/harness';
import { signedTx } from './support/tx';
import { KEY_ADDRESS, KEY_PUBLIC, MINT, RECIPIENT } from './support/vectors';
import { READ } from '../../../src/adapters/solana/rpc';

const ref = (id: string) => ({ id, idKind: 'signature' as const, canonical: true });
const ORDERING = { kind: 'expiry' as const, lastValidHeight: 1_000n };
const OTHER_MINT = 'So11111111111111111111111111111111111111112';

function setup(endpoints?: readonly Endpoint[]) {
  const h = solanaHarness(endpoints ? { endpoints } : {});
  h.node.fund(KEY_ADDRESS, 10_000_000_000n);
  h.node.createMint(MINT, 6);
  h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
  h.node.produce(2);
  return { ...h, reader: createSolanaReader(h.ctx) };
}

/** Sends 2 tokens to RECIPIENT (creating its account) and mines the block. */
function tokenTransfer(h: ReturnType<typeof setup>): string {
  const destination = associatedAddress(RECIPIENT, MINT);
  const id = h.node.submit(
    signedTx(h.node.head.hash, [
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
      transferChecked(
        associatedAddress(KEY_ADDRESS, MINT),
        MINT,
        destination,
        KEY_ADDRESS,
        2_000_000n,
        6,
      ),
    ]),
  );
  h.node.produce(1);
  return id;
}

describe('Solana addresses', () => {
  const codec = createSolanaAddressCodec();
  it('validates, normalizes and derives strictly', () => {
    expect(codec.validate(KEY_ADDRESS)).toBe(true);
    expect(codec.normalize(KEY_ADDRESS)).toEqual({
      canonical: KEY_ADDRESS,
      display: KEY_ADDRESS,
    });
    expect(() => codec.normalize(`${KEY_ADDRESS}x`)).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
    expect(codec.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    expect(() => codec.fromPublicKey(KEY_PUBLIC.slice(0, 31))).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
    // An overlong text is refused before it is decoded.
    expect(codec.validate('1'.repeat(100_000))).toBe(false);
  });
});

describe('the Solana reader', () => {
  it('reads balances: lamports, and every classic token account of an owner', async () => {
    const h = setup();
    // A second account of the same mint, owned by the same wallet (not its ATA).
    const extra = associatedAddress(RECIPIENT, OTHER_MINT);
    h.node.setAccount(extra, {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      lamports: h.node.rent(165),
      data: h.node.account(associatedAddress(KEY_ADDRESS, MINT))!.data,
    });
    h.calls.length = 0;
    expect(await h.run(h.reader.getBalance(KEY_ADDRESS, 'native'))).toBe(10_000_000_000n);
    expect(
      await h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'spl', contract: MINT })),
    ).toBe(10_000_000n);
    expect(
      await h.run(h.reader.getBalance(RECIPIENT, { standard: 'spl', contract: MINT })),
    ).toBe(0n);
    expect(
      h.calls.every((c) => c.tags.purpose === 'read' && c.tags.retry === 'safe'),
    ).toBe(true);
    await expect(
      h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'erc20', contract: MINT })),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
  });

  it('never counts an account twice, nor one of another owner or mint (lookups by id)', async () => {
    const h = setup();
    const listed = (params: readonly unknown[]) =>
      h.node.answer('main', 'getTokenAccountsByOwner', params) as {
        value: { pubkey: string; account: unknown }[];
      };
    // A node that ignores the filters: RECIPIENT's balance is none of KEY_ADDRESS's tokens.
    h.node.intercept = (_endpoint, method, params) =>
      method === 'getTokenAccountsByOwner'
        ? { result: listed([KEY_ADDRESS, ...params.slice(1)]) }
        : undefined;
    expect(
      await h.run(h.reader.getBalance(RECIPIENT, { standard: 'spl', contract: MINT })),
    ).toBe(0n);
    // A node that lists every mint's accounts: only the mint asked for counts.
    h.node.createMint(RECIPIENT, 6);
    h.node.mintTo(RECIPIENT, KEY_ADDRESS, 7n);
    h.node.intercept = (_endpoint, method, params) =>
      method === 'getTokenAccountsByOwner'
        ? { result: listed([params[0], { programId: TOKEN }, params[2]]) }
        : undefined;
    expect(
      await h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'spl', contract: MINT })),
    ).toBe(5_000_000n);
    // The same account listed twice is not a doubled balance.
    h.node.intercept = (_endpoint, method, params) => {
      if (method !== 'getTokenAccountsByOwner') return undefined;
      const answer = listed(params);
      return { result: { ...answer, value: [...answer.value, ...answer.value] } };
    };
    await expect(
      h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'spl', contract: MINT })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    h.node.intercept = undefined;
    expect(
      await h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'spl', contract: MINT })),
    ).toBe(5_000_000n);
  });

  it('reads balances above 2^53 lamports exactly', async () => {
    const h = setup();
    h.node.fund(RECIPIENT, 2n ** 60n + 1n);
    expect(await h.run(h.reader.getBalance(RECIPIENT, 'native'))).toBe(2n ** 60n + 1n);
  });

  it('reads heights at confirmed and finalized as monitor reads, and blocks by height', async () => {
    const h = setup();
    h.node.skip(2);
    h.node.produce(3);
    h.calls.length = 0;
    expect(await h.run(h.reader.getBlockHeight())).toBe(5n);
    expect(await h.run(h.reader.getFinalizedHeight())).toBe(3n);
    expect(h.calls.map((c) => [c.method, c.tags.purpose, c.params])).toEqual([
      ['getBlockHeight', 'monitor', [{ commitment: 'confirmed' }]],
      ['getBlockHeight', 'monitor', [{ commitment: 'finalized' }]],
    ]);
    expect(await h.run(h.reader.getBlock(4n))).toEqual({
      height: 4n,
      hash: h.node.block(4n)?.hash,
      parentHash: h.node.block(3n)?.hash,
      timestamp: expect.any(Number),
    });
    expect(await h.run(h.reader.getBlock(6n))).toBeNull();
    await expect(h.run(h.reader.getBlock(h.node.head.hash))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('checks a block against the height it claims, and drops the cache on a contradiction', async () => {
    const h = setup();
    h.node.produce(4);
    const slot = h.node.block(3n)?.slot as bigint;
    expect((await h.run(h.reader.getBlock(3n)))?.hash).toBe(h.node.block(3n)?.hash);
    const header = h.node.answer('main', 'getBlock', [
      Number(slot),
      { commitment: 'confirmed', transactionDetails: 'none' },
    ]) as Record<string, unknown>;
    h.node.intercept = (_endpoint, method, params) =>
      method === 'getBlock' && params[0] === Number(slot)
        ? { result: { ...header, blockHeight: 2 } }
        : undefined;
    await expect(h.run(h.reader.getBlock(3n))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.intercept = undefined;
    h.calls.length = 0;
    expect((await h.run(h.reader.getBlock(3n)))?.hash).toBe(h.node.block(3n)?.hash);
    expect(h.calls.map((c) => c.method)).toContain('getBlocks');
  });

  it('reads and decodes transactions; a malformed id is simply not found', async () => {
    const h = setup();
    const id = h.node.submit(
      signedTx(h.node.head.hash, [
        systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
      ]),
    );
    h.node.produce(1);
    const tx = await h.run(h.reader.getTransaction(id));
    expect(tx).toMatchObject({
      id,
      observation: {
        seen: 'block',
        blockHeight: 3n,
        blockHash: h.node.block(3n)?.hash,
        success: true,
      },
      transfers: [
        { locator: 'ix:0', to: RECIPIENT, asset: 'native', amount: 1_000_000_000n },
      ],
      decoding: 'complete',
    });
    h.calls.length = 0;
    expect(await h.run(h.reader.getTransaction('not-a-signature'))).toBeNull();
    expect(await h.run(h.reader.getTransaction('1'.repeat(100_000)))).toBeNull();
    expect(await h.run(h.reader.observe(ref('0x12'), undefined, undefined))).toEqual({
      seen: 'none',
    });
    expect(h.calls).toEqual([]);
  });

  it('never reads another transaction as the one asked for', async () => {
    const h = setup();
    const send = (lamports: bigint) =>
      h.node.submit(
        signedTx(h.node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, lamports)]),
      );
    const id = send(1_000_000_000n);
    const other = send(2_000_000_000n);
    h.node.produce(1);
    const answer = h.node.answer('main', 'getTransaction', [
      other,
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    h.node.intercept = (_endpoint, method) =>
      method === 'getTransaction' ? { result: answer } : undefined;
    await expect(h.run(h.reader.getTransaction(id))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(
      h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('observes our own token transfers with the phantom-success guard, others as the chain says', async () => {
    const h = setup();
    const id = tokenTransfer(h);
    expect(await h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS))).toEqual({
      seen: 'block',
      txHash: id,
      blockHeight: 3n,
      blockHash: h.node.block(3n)?.hash,
      success: true,
    });
    h.calls.length = 0;
    // An answer whose balances do not show our transfer: nothing moved.
    const raw = (await rawTransaction(h, id)) as {
      meta: {
        preTokenBalances: { accountIndex: number; uiTokenAmount: { amount: string } }[];
        postTokenBalances: { accountIndex: number; uiTokenAmount: { amount: string } }[];
      };
    };
    const before = new Map(
      raw.meta.preTokenBalances.map((b) => [b.accountIndex, b.uiTokenAmount.amount]),
    );
    const tampered = {
      ...raw,
      meta: {
        ...raw.meta,
        postTokenBalances: raw.meta.postTokenBalances.map((b) => ({
          ...b,
          uiTokenAmount: {
            ...b.uiTokenAmount,
            amount: before.get(b.accountIndex) ?? '0',
          },
        })),
      },
    };
    h.node.intercept = (_endpoint, method) =>
      method === 'getTransaction' ? { result: tampered } : undefined;
    expect(await h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS))).toMatchObject({
      success: false,
      reason: 'token transfer failed',
    });
    expect(h.calls.every((c) => c.tags.purpose === 'monitor')).toBe(true);
    // An unmanaged lookup reports the chain's own view.
    expect(await h.run(h.reader.observe(ref(id), undefined, undefined))).toMatchObject({
      success: true,
    });
    // Missing evidence (the created account's balance left out) decides nothing.
    const missing = {
      ...raw,
      meta: { ...raw.meta, postTokenBalances: raw.meta.preTokenBalances },
    };
    h.node.intercept = (_endpoint, method) =>
      method === 'getTransaction' ? { result: missing } : undefined;
    await expect(
      h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('classifies token metadata failures', async () => {
    const h = setup();
    const meta = (mint: string) =>
      h.run(h.reader.getTokenMetadata!({ standard: 'spl', contract: mint }));
    expect(await meta(MINT)).toEqual({ symbol: MINT.slice(0, 8), decimals: 6 });
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
      message: 'no mint at this address',
    });
    h.node.fund(OTHER_MINT, 1_000_000n);
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    h.node.createMint(RECIPIENT, 6, TOKEN_2022);
    await expect(meta(RECIPIENT)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    h.node.setAccount(OTHER_MINT, {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: new Uint8Array(82),
    });
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      message: 'the mint does not parse',
    });
    await expect(meta('bad')).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    expect(h.reader.normalizeTokenRef!({ standard: 'spl', contract: MINT })).toEqual({
      standard: 'spl',
      contract: MINT,
    });
  });

  it('reads token metadata under the proof quorum, comparing the mint verdict only', async () => {
    const h = setup(['a', 'b']);
    const meta = () =>
      h.run(h.reader.getTokenMetadata!({ standard: 'spl', contract: MINT }));
    const scripted = (change: (answer: Record<string, unknown>) => unknown) => {
      h.node.intercept = (endpoint, method, params) =>
        endpoint === 'b' && method === 'getAccountInfo'
          ? {
              result: change(
                h.node.answer('b', method, params) as Record<string, unknown>,
              ),
            }
          : undefined;
    };
    /** Endpoint b's mint account with byte `at` set to `to`, at a later context slot. */
    const withByte = (at: number, to: number) =>
      scripted((answer) => {
        const value = answer.value as { data: [string, string]; lamports: number };
        const data = Buffer.from(value.data[0], 'base64');
        data[at] = to;
        return {
          context: { apiVersion: '4.3.0', slot: 1_000 },
          value: {
            ...value,
            lamports: value.lamports + 1,
            data: [data.toString('base64'), 'base64'],
          },
        };
      });
    h.calls.length = 0;
    expect(await meta()).toEqual({ symbol: MINT.slice(0, 8), decimals: 6 });
    expect(h.calls.map((c) => [c.method, c.tags])).toEqual([
      ['getAccountInfo', { purpose: 'read', retry: 'safe', quorum: 'proof' }],
    ]);
    // Per-node fields (the context slot, lamports, the supply) never disagree.
    withByte(36, 0xff);
    expect(await meta()).toEqual({ symbol: MINT.slice(0, 8), decimals: 6 });
    // Another decimals, or no mint on a lagging endpoint, decides nothing (never cached).
    withByte(44, 9);
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    scripted((answer) => ({ ...answer, value: null }));
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    // A malformed answer on one endpoint never agrees with another's verdict.
    scripted(() => ({ context: { slot: 1 } }));
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('reads a malformed mint answer as retryable, never as a verdict the core caches', async () => {
    const h = setup();
    const meta = () =>
      h.run(h.reader.getTokenMetadata!({ standard: 'spl', contract: MINT }));
    const account = (change: (value: Record<string, unknown>) => unknown) => {
      h.node.intercept = (endpoint, method, params) => {
        if (method !== 'getAccountInfo') return undefined;
        const answer = h.node.answer(endpoint, method, params) as {
          value: Record<string, unknown>;
        };
        return { result: { ...answer, value: change(answer.value) } };
      };
    };
    // Base64 with a stray character still decodes leniently in Node: refused first.
    account((value) => {
      const [data] = value.data as [string, string];
      return { ...value, data: [`${data.slice(0, 8)}*${data.slice(8)}`, 'base64'] };
    });
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // An owner that is no address is not "another program's account".
    account((value) => ({ ...value, owner: 'nope' }));
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    account((value) => ({ ...value, executable: undefined }));
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // Non-canonical pad bits: `AB==` decodes to the byte `AA==` holds.
    account((value) => ({ ...value, data: ['AB==', 'base64'] }));
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'malformed getAccountInfo answer',
    });
    // A missing field is malformed, never a default (one endpoint: no quorum involved).
    h.node.intercept = (_endpoint, method) =>
      method === 'getAccountInfo' ? { result: { context: { slot: 1 } } } : undefined;
    await expect(meta()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'malformed getAccountInfo answer',
    });
    h.node.intercept = undefined;
    expect(await meta()).toEqual({ symbol: MINT.slice(0, 8), decimals: 6 });
  });

  it('reads accounts of any size the chain allows, up to 10 MiB', async () => {
    const h = setup();
    for (const size of [4 * 1024 * 1024, 10 * 1024 * 1024]) {
      const data = new Uint8Array(size).fill(7);
      data[size - 1] = 9;
      h.node.setAccount(RECIPIENT, { owner: KEY_ADDRESS, data });
      const info = await h.run(accountInfo(h.ctx, RECIPIENT, READ));
      expect(info?.owner).toBe(KEY_ADDRESS);
      expect(info?.data.length).toBe(size);
      expect([info?.data[0], info?.data[size - 1]]).toEqual([7, 9]);
    }
    // An empty account's data is the empty text.
    h.node.setAccount(RECIPIENT, { owner: KEY_ADDRESS, data: new Uint8Array() });
    expect((await h.run(accountInfo(h.ctx, RECIPIENT, READ)))?.data.length).toBe(0);
  });

  it('makes a node error retryable and keeps PROVIDER_MISCONFIGURED final', async () => {
    const failing = (error: unknown): SolanaContext =>
      ({
        ...solanaHarness().ctx,
        transport: { rpc: () => Promise.reject(error) },
      }) as unknown as SolanaContext;
    const definitive = new ProviderError('RPC_ERROR', 'getAccountInfo failed: x', {
      details: { rpcCode: -32603, rpcMessage: 'x' },
    });
    await expect(
      createSolanaReader(failing(definitive)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: true });
    const misconfigured = new ProviderError(
      'PROVIDER_MISCONFIGURED',
      'identity mismatch',
    );
    await expect(
      createSolanaReader(failing(misconfigured)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toBe(misconfigured);
    const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'down');
    await expect(
      createSolanaReader(failing(transient)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toBe(transient);
  });

  it('lists token accounts through ext.solana', async () => {
    const h = setup();
    const ext = createSolanaExt(h.ctx);
    expect(await h.run(ext.solana.getTokenAccounts(KEY_ADDRESS))).toEqual([
      {
        address: associatedAddress(KEY_ADDRESS, MINT),
        mint: MINT,
        amount: 5_000_000n,
        frozen: false,
      },
    ]);
    expect(await h.run(ext.solana.getTokenAccounts(KEY_ADDRESS, OTHER_MINT))).toEqual([]);
    await expect(h.run(ext.solana.getTokenAccounts('nope'))).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    });
  });
});

async function rawTransaction(h: ReturnType<typeof setup>, id: string): Promise<unknown> {
  const response = await h.node.fetch.fetch('https://main.solana.test/', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        id,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  return ((await response.json()) as { result: unknown }).result;
}
