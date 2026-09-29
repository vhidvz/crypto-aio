import { base58 } from '@scure/base';
import { PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { classifyBroadcastError } from '../../../src/adapters/solana/errors';
import {
  createAssociatedTokenAccountIdempotent,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { BROADCAST, READ, rpcCode, rpcMessage } from '../../../src/adapters/solana/rpc';
import type { SolanaInstruction } from '../../../src/adapters/solana/types';
import { signedTransaction } from '../../../src/adapters/solana/wire';
import type { CryptoAioError } from '../../../src/core/errors/error';
import { FakeClock } from '../../../src/testing/fake-clock';
import { nodeTransport } from './support/harness';
import {
  DEVNET_GENESIS,
  ScriptedSolanaNode,
  associatedAddress,
  MEMO,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  faults,
} from './support/node';
import { codec, signedTx } from './support/tx';
import { KEY_ADDRESS, MINT, RECIPIENT, RECIPIENT_KEY, sign } from './support/vectors';

function setup(options: { blockhashValidity?: number } = {}) {
  const node = new ScriptedSolanaNode({ clock: new FakeClock(), ...options });
  const url = node.endpoint('main');
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await node.fetch.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return JSON.parse(text) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
  };
  const tx = (
    instructions: SolanaInstruction[],
    options: { blockhash?: string; key?: string } = {},
  ) => signedTx(options.blockhash ?? node.head.hash, instructions, options);
  const send = (raw: string, config: Record<string, unknown> = {}) =>
    rpc('sendTransaction', [
      raw,
      { encoding: 'base64', preflightCommitment: 'confirmed', ...config },
    ]);
  return { node, rpc, tx, send };
}

describe('the scripted Solana node', () => {
  it('keeps block heights dense over skipped slots', async () => {
    const { node, rpc } = setup();
    node.produce(2);
    node.skip(3);
    node.produce(2);
    expect([node.head.slot, node.head.height]).toEqual([7n, 4n]);
    expect((await rpc('getBlocks', [0, 10, { commitment: 'confirmed' }])).result).toEqual(
      [0, 1, 2, 6, 7],
    );
    expect(
      (
        await rpc('getBlock', [
          6,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).result,
    ).toMatchObject({
      blockHeight: 3,
      parentSlot: 2,
      previousBlockhash: node.block(2n)?.hash,
    });
    expect(
      (
        await rpc('getBlock', [
          4,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).error,
    ).toEqual({
      code: -32007,
      message: 'Slot 4 was skipped, or missing due to ledger jump to recent snapshot',
    });
    expect(
      (
        await rpc('getBlock', [
          9,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).error?.code,
    ).toBe(-32004);
    // `finalized` is two heights below the head: slot 6 (height 3) is not final yet.
    expect(
      (
        await rpc('getBlock', [
          6,
          { commitment: 'finalized', transactionDetails: 'none' },
        ])
      ).error?.code,
    ).toBe(-32004);
    expect((await rpc('getBlockHeight', [{ commitment: 'finalized' }])).result).toBe(2);
    expect((await rpc('getBlock', [6, { commitment: 'processed' }])).error?.code).toBe(
      -32602,
    );
  });

  it('includes a transaction up to lastValidBlockHeight + 1, never later (I1)', async () => {
    const { node, rpc, tx, send } = setup({ blockhashValidity: 3 });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]))
      .result as {
      value: { blockhash: string; lastValidBlockHeight: number };
    };
    expect(latest.value).toEqual({ blockhash: node.head.hash, lastValidBlockHeight: 4 });
    const raw = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]);
    expect((await send(raw)).result).toEqual(expect.any(String));
    node.produce(1);
    expect(node.balance(RECIPIENT)).toBe(1_000_000_000n);
    // Signed at height 1 (lastValidBlockHeight 4): agave checks the blockhash's age against
    // the including block's parent, so it can still land at height 5; at height 6 it is dead.
    const edge = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 7n)], {
      blockhash: node.block(1n)?.hash,
    });
    const late = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 8n)], {
      blockhash: node.block(1n)?.hash,
    });
    node.produce(2);
    const edgeId = (await send(edge, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(edgeId)?.block.height).toBe(5n);
    expect((await send(late)).error?.message).toBe(
      'Transaction simulation failed: Blockhash not found',
    );
    const lateId = (await send(late, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(lateId)).toBeUndefined();
    expect(node.inMempool(lateId)).toBe(false);
  });

  it('checks preflight at finalized unless told otherwise, and knows processed transactions', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(3);
    const raw = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]);
    // The head's blockhash is not in the finalized bank yet.
    expect((await send(raw, { preflightCommitment: undefined })).error).toMatchObject({
      code: -32002,
      message: 'Transaction simulation failed: Blockhash not found',
    });
    const id = (await send(raw)).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    expect((await send(raw)).error?.message).toBe(
      'Transaction simulation failed: This transaction has already been processed',
    );
    expect(node.sendCount(id)).toBe(3);
  });

  it('verifies signatures under preflight (-32002); without it, forwards bytes that never land (M1)', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const forged = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)], {
      key: RECIPIENT_KEY,
    });
    expect((await send(forged)).error).toMatchObject({
      code: -32002,
      message:
        'Transaction simulation failed: Transaction did not pass signature verification',
    });
    const id = (await send(forged, { skipPreflight: true })).result as string;
    node.produce(1);
    expect([node.landed(id), node.inMempool(id), node.sendCount(id)]).toEqual([
      undefined,
      false,
      2,
    ]);
  });

  it('charges 5,000 lamports per signature plus the priority fee, even when execution fails', async () => {
    const { node, tx, send, rpc } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const budget = [setComputeUnitLimit(30_000n), setComputeUnitPrice(1_000_001n)];
    const message = codec.compileMessage(KEY_ADDRESS, node.head.hash, [
      ...budget,
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
    ]);
    // ceil(1_000_001 × 30_000 / 1e6) = 30_001.
    expect(
      (
        await rpc('getFeeForMessage', [
          Buffer.from(message).toString('base64'),
          { commitment: 'confirmed' },
        ])
      ).result,
    ).toMatchObject({ value: 35_001 });
    // Too many units for the limit: the transaction lands failed and pays the fee.
    const starved = tx([
      setComputeUnitLimit(200n),
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
    ]);
    const id = (await send(starved, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toEqual({
      InstructionError: [1, 'ComputationalBudgetExceeded'],
    });
    expect(node.balance(KEY_ADDRESS)).toBe(10_000_000_000n - 5_000n);
    expect(node.balance(RECIPIENT)).toBe(0n);
  });

  it('enforces rent-exempt minimums on new accounts and on the fee payer', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000n);
    node.produce(1);
    expect(node.rent(0)).toBe(650_240n);
    expect(node.rent(165)).toBe(1_488_440n);
    expect(
      (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000n)]))).error?.message,
    ).toBe(
      'Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent',
    );
    // Leaving the payer between 0 and its minimum is refused too; emptying it is fine.
    expect(
      (
        await send(
          tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 10_000_000n - 5_000n - 100n)]),
        )
      ).error?.message,
    ).toBe(
      'Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent',
    );
    const sweep = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 10_000_000n - 5_000n)]);
    expect((await send(sweep)).result).toEqual(expect.any(String));
    node.produce(1);
    expect([node.balance(KEY_ADDRESS), node.balance(RECIPIENT)]).toEqual([
      0n,
      9_995_000n,
    ]);
    expect(
      (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1n)]))).error?.message,
    ).toBe(
      'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
    );
  });

  it('runs SPL transfers with the token program rules, and creates ATAs idempotently', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    node.produce(1);
    const destination = associatedAddress(RECIPIENT, MINT);
    const create = createAssociatedTokenAccountIdempotent(
      KEY_ADDRESS,
      destination,
      RECIPIENT,
      MINT,
    );
    const transfer = (amount: bigint, decimals = 6) =>
      transferChecked(source, MINT, destination, KEY_ADDRESS, amount, decimals);
    expect((await send(tx([create, transfer(1n, 9)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x12',
    );
    expect((await send(tx([create, transfer(6_000_000n)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1',
    );
    const id = (await send(tx([create, transfer(2_000_000n), memo('hello')])))
      .result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    expect(node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
    expect(node.balance(destination)).toBe(1_488_440n);
    // A second create is a no-op; a frozen account refuses.
    node.mintTo(MINT, RECIPIENT, 0n, { frozen: true });
    node.produce(1);
    expect((await send(tx([create, transfer(1n)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x11',
    );
  });

  it('forks below the head only, returning transactions to the mempool', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(3);
    const id = (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)])))
      .result as string;
    node.produce(1);
    const before = node.head.hash;
    node.reorg(1);
    expect(node.inMempool(id)).toBe(true);
    node.produce(1);
    expect(node.head.hash).not.toBe(before);
    expect(node.landed(id)?.block.height).toBe(4n);
    expect(() => node.reorg(3)).toThrow('cannot reorg below the finalized block');
  });

  it('serves lagging and pruned endpoints their own view, and exact u64 numbers', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const lagging = node.endpoint('lagging', { lag: 2 });
    const pruned = node.endpoint('pruned', { firstAvailableHeight: 3 });
    node.fund(KEY_ADDRESS, 2n ** 60n);
    node.produce(5);
    const call = async (url: string, method: string, params: unknown[]) =>
      (
        await node.fetch.fetch(url, {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).text();
    expect(
      await call(lagging, 'getBlockHeight', [{ commitment: 'confirmed' }]),
    ).toContain('"result":3');
    expect(
      await call(pruned, 'getBlock', [
        2,
        { commitment: 'confirmed', transactionDetails: 'none' },
      ]),
    ).toContain('"code":-32001');
    expect(
      await call(pruned, 'getBalance', [KEY_ADDRESS, { commitment: 'confirmed' }]),
    ).toContain('"value":1152921504606846976');
  });

  it('serves a load-balanced URL from its backends in turn, gaps and all', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const url = node.endpoint('lb', {
      backends: [{}, { lag: 2, missingHeights: [3n] }],
    });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const id = node.submit(
      signedTx(node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]),
    );
    node.produce(1);
    node.produce(4);
    const call = async (method: string, params: unknown[]) =>
      JSON.parse(
        await (
          await node.fetch.fetch(url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).text(),
      ) as { result?: unknown; error?: { code: number } };
    const heights = [
      (await call('getBlockHeight', [{ commitment: 'confirmed' }])).result,
      (await call('getBlockHeight', [{ commitment: 'confirmed' }])).result,
    ];
    expect(heights).toEqual([6, 4]);
    const header = { commitment: 'confirmed', transactionDetails: 'none' };
    expect((await call('getBlock', [2, header])).result).toMatchObject({
      blockHeight: 2,
    });
    // The second backend's ledger lacks height 3.
    expect((await call('getBlock', [3, header])).error?.code).toBe(-32009);
    expect(
      (await call('getBlocks', [0, 10, { commitment: 'confirmed' }])).result,
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      (await call('getBlocks', [0, 10, { commitment: 'confirmed' }])).result,
    ).toEqual([0, 1, 2, 4]);
    const options = {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    };
    expect((await call('getTransaction', [id, options])).result).toMatchObject({
      slot: 2,
    });
    expect((await call('getTransaction', [id, options])).result).toMatchObject({
      slot: 2,
    });
  });

  it('fails long-term-storage reads below the local ledger as agave 4.3.0 does (R1)', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const url = node.endpoint('bt', { bigtableFailsBelow: 4n });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const id = node.submit(
      signedTx(node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]),
    );
    node.produce(8);
    const call = async (method: string, params: unknown[]) =>
      JSON.parse(
        await (
          await node.fetch.fetch(url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).text(),
      ) as { result?: unknown; error?: { code: number; message: string } };
    const slot = (height: bigint) => Number(node.block(height)?.slot);
    const finalized = { commitment: 'finalized' };
    expect((await call('getBlocks', [slot(1n), slot(6n), finalized])).error).toEqual({
      code: -32602,
      message: 'BigTable query failed (maybe timeout due to too large range?)',
    });
    expect((await call('getBlocks', [slot(4n), slot(6n), finalized])).result).toEqual([
      slot(4n),
      slot(5n),
      slot(6n),
    ]);
    const header = { ...finalized, transactionDetails: 'none' };
    expect((await call('getBlock', [slot(2n), header])).result).toBeNull();
    expect((await call('getBlock', [slot(4n), header])).result).toMatchObject({
      blockHeight: 4,
    });
    const options = { ...finalized, encoding: 'jsonParsed' };
    expect(node.landed(id)?.block.height).toBe(2n);
    expect((await call('getTransaction', [id, options])).result).toBeNull();
  });

  it('answers an unknown history cursor with -32020 (M2)', async () => {
    const { node, rpc } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const before = '1'.repeat(64);
    expect(
      (await rpc('getSignaturesForAddress', [KEY_ADDRESS, { before }])).error,
    ).toEqual({ code: -32020, message: `Transaction ${before} not found` });
  });
});

describe('the scripted Solana node: runtime and program rules (lesson 8)', () => {
  it('applies each transaction atomically: a refusal leaves no trace, even across a fork', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    node.produce(3);
    const destination = associatedAddress(RECIPIENT, MINT);
    // Instruction 0 creates the recipient's account; instruction 1 then fails.
    const bad = tx([
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
      transferChecked(source, MINT, destination, KEY_ADDRESS, 1n, 9),
    ]);
    const head = node.head.hash;
    expect((await send(bad)).error?.code).toBe(-32002);
    expect([
      node.head.hash,
      node.balance(KEY_ADDRESS),
      node.account(destination),
    ]).toEqual([head, 10_000_000_000n, undefined]);
    // Its payer has no account: a load error, so it never lands and leaves nothing behind.
    const unpayable = signedTx(
      node.head.hash,
      [systemTransfer(RECIPIENT, KEY_ADDRESS, 1n)],
      {
        payer: RECIPIENT,
        key: RECIPIENT_KEY,
      },
    );
    const unpayableId = (await send(unpayable, { skipPreflight: true })).result as string;
    const id = (await send(bad, { skipPreflight: true })).result as string;
    node.produce(1);
    const failed = { InstructionError: [1, { Custom: 18 }] };
    expect(node.landed(id)?.err).toEqual(failed);
    expect([node.account(destination), node.balance(KEY_ADDRESS)]).toEqual([
      undefined,
      10_000_000_000n - 5_000n,
    ]);
    expect([node.landed(unpayableId), node.inMempool(unpayableId)]).toEqual([
      undefined,
      false,
    ]);
    // Across a fork, the failed transaction lands failed again, charged once.
    node.reorg(1);
    expect(node.balance(KEY_ADDRESS)).toBe(10_000_000_000n);
    expect([node.inMempool(id), node.inMempool(unpayableId)]).toEqual([true, false]);
    node.produce(1);
    expect(node.landed(id)?.err).toEqual(failed);
    expect([
      node.account(destination),
      node.balance(KEY_ADDRESS),
      node.landed(unpayableId),
    ]).toEqual([undefined, 10_000_000_000n - 5_000n, undefined]);
  });

  it("keeps a landed transaction's meta as it landed, whatever is scripted later (I1)", async () => {
    const { node, rpc, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    const destination = node.mintTo(MINT, RECIPIENT, 0n);
    node.produce(1);
    const id = (
      await send(
        tx([
          systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
          transferChecked(source, MINT, destination, KEY_ADDRESS, 2_000_000n, 6),
        ]),
      )
    ).result as string;
    node.produce(1);
    const slot = Number(node.head.slot);
    const read = async () => {
      const options = {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      };
      const found = (await rpc('getTransaction', [id, options])).result as {
        meta: unknown;
      };
      const block = (await rpc('getBlock', [slot, options])).result as {
        transactions: { meta: unknown }[];
      };
      return [found.meta, block.transactions.map((t) => t.meta)];
    };
    const landed = await read();
    expect(landed[0]).toMatchObject({
      preBalances: [10_000_000_000, 0, 1_488_440, 1_488_440, 1, 1, 1_066_800],
      postBalances: [
        10_000_000_000 - 1_000_000_000 - 5_000,
        1_000_000_000,
        1_488_440,
        1_488_440,
        1,
        1,
        1_066_800,
      ],
    });
    // Scripting rewrites the accounts' history, never a landed transaction's meta.
    node.fund(RECIPIENT, 5n);
    node.mintTo(MINT, RECIPIENT, 7n);
    node.setAccount(KEY_ADDRESS, { lamports: 1n });
    expect(await read()).toEqual(landed);
    expect([node.balance(RECIPIENT), node.tokenBalance(MINT, RECIPIENT)]).toEqual([
      1_000_000_005n,
      2_000_007n,
    ]);
  });

  it("checks an SPL transfer in the token program's order: frozen, funds, mint, decimals, owner", async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.fund(RECIPIENT, 10_000_000_000n);
    node.createMint(MINT, 6);
    node.createMint(DEVNET_GENESIS, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    const destination = node.mintTo(MINT, RECIPIENT, 0n);
    const other = node.mintTo(DEVNET_GENESIS, RECIPIENT, 0n);
    node.produce(1);
    const transfer = (
      amount: bigint,
      decimals: number,
      authority = KEY_ADDRESS,
      to = destination,
    ) => transferChecked(source, MINT, to, authority, amount, decimals);
    const error = async (raw: string) =>
      (await send(raw)).error?.message.replace(
        'Transaction simulation failed: Error processing Instruction 0: ',
        '',
      );
    // Signed by the recipient, who does not own the source account.
    const stranger = (amount: bigint, decimals: number) =>
      signedTx(node.head.hash, [transfer(amount, decimals, RECIPIENT)], {
        payer: RECIPIENT,
        key: RECIPIENT_KEY,
      });
    expect(await error(tx([transfer(6_000_000n, 9)]))).toBe('custom program error: 0x1');
    expect(await error(tx([transfer(1n, 9, KEY_ADDRESS, other)]))).toBe(
      'custom program error: 0x3',
    );
    expect(await error(stranger(1n, 9))).toBe('custom program error: 0x12');
    expect(await error(stranger(1n, 6))).toBe('custom program error: 0x4');
    node.mintTo(MINT, RECIPIENT, 0n, { frozen: true });
    node.produce(1);
    expect(await error(tx([transfer(6_000_000n, 9)]))).toBe('custom program error: 0x11');
  });

  it('creates an associated token account as the ATA program does', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const destination = associatedAddress(RECIPIENT, MINT);
    // Lamports sent to the address before its creation stay; the payer adds the rest.
    node.fund(destination, 1_000_000n);
    node.produce(1);
    const create = (address: string, mint = MINT) =>
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, address, RECIPIENT, mint);
    const error = async (raw: string) => (await send(raw)).error?.message;
    expect(await error(tx([create(associatedAddress(KEY_ADDRESS, MINT))]))).toBe(
      'Transaction simulation failed: Error processing Instruction 0: Provided seeds do not result in a valid address',
    );
    // Not a mint: the token program does not own that account.
    expect(
      await error(tx([create(associatedAddress(RECIPIENT, RECIPIENT), RECIPIENT)])),
    ).toBe(
      'Transaction simulation failed: Error processing Instruction 0: incorrect program id for instruction',
    );
    const id = (await send(tx([create(destination)]))).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    expect([node.balance(destination), node.balance(KEY_ADDRESS)]).toEqual([
      1_488_440n,
      10_000_000_000n - 5_000n - (1_488_440n - 1_000_000n),
    ]);
    expect(node.account(destination)?.owner).toBe(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
  });

  it("lets a rent-paying account only shrink, as agave's rent-state rule does", async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    // A legacy account below its rent-exempt minimum.
    node.fund(RECIPIENT, 100_000n);
    node.produce(1);
    expect(
      (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1n)]))).error?.message,
    ).toBe(
      'Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent',
    );
    // As a fee payer it may still pay and send, since it only shrinks.
    const raw = signedTx(
      node.head.hash,
      [systemTransfer(RECIPIENT, KEY_ADDRESS, 1_000n)],
      {
        payer: RECIPIENT,
        key: RECIPIENT_KEY,
      },
    );
    expect((await send(raw)).result).toEqual(expect.any(String));
    node.produce(1);
    expect(node.balance(RECIPIENT)).toBe(94_000n);
  });

  it('saturates a fee at u64::MAX as agave does, written as an exact number', async () => {
    const { node } = setup();
    node.produce(1);
    const message = codec.compileMessage(KEY_ADDRESS, node.head.hash, [
      setComputeUnitLimit(1_400_000n),
      setComputeUnitPrice(2n ** 64n - 1n),
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1n),
    ]);
    const response = await node.fetch.fetch('https://main.solana.test/', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getFeeForMessage',
        params: [Buffer.from(message).toString('base64'), { commitment: 'confirmed' }],
      }),
    });
    expect(await response.text()).toContain('"value":18446744073709551615}');
  });

  it('names slots in its "not available" errors, as agave does', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const main = node.endpoint('main');
    const pruned = node.endpoint('pruned', { firstAvailableHeight: 3 });
    node.produce(2);
    node.skip(2);
    node.produce(3);
    // Heights 0–5 sit at slots 0, 1, 2, 5, 6, 7.
    const call = async (url: string, method: string, params: unknown[]) =>
      (
        JSON.parse(
          await (
            await node.fetch.fetch(url, {
              method: 'POST',
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            })
          ).text(),
        ) as { error?: unknown }
      ).error;
    expect(
      await call(pruned, 'getBlock', [
        1,
        { commitment: 'confirmed', transactionDetails: 'none' },
      ]),
    ).toEqual({
      code: -32001,
      message: 'Block 1 cleaned up, does not exist on node. First available block: 5',
    });
    expect(
      await call(main, 'getBlocks', [
        0,
        10,
        { commitment: 'confirmed', minContextSlot: 8 },
      ]),
    ).toEqual({
      code: -32016,
      message: 'Minimum context slot has not been reached',
      data: { contextSlot: 7 },
    });
  });
});

describe("the scripted Solana node: agave's RPC surface (F5-R5)", () => {
  const TYPE = 'solana_transaction::versioned::VersionedTransaction';

  // CPU-bound: under 3 s alone but 6.6–8.9 s under load, so it has its own budget rather
  // than Jest's 5 s default (final-wave re-review N2).
  it('refuses oversized transactions before anything else, with or without preflight (M1)', async () => {
    const { node, rpc } = setup();
    node.produce(1);
    const error = async (data: string, encoding: string, method = 'sendTransaction') =>
      (await rpc(method, [data, { encoding, skipPreflight: true }])).error;
    const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');
    // 1,232 bytes pass the size checks (and then fail to deserialize); 1,233 still fit
    // agave's 1,644 base64 characters.
    expect((await error(b64(1_232), 'base64'))?.message).toMatch(
      `failed to deserialize ${TYPE}: `,
    );
    expect(b64(1_233)).toHaveLength(1_644);
    for (const method of ['sendTransaction', 'simulateTransaction']) {
      expect(await error(b64(1_233), 'base64', method)).toEqual({
        code: -32602,
        message: `decoded ${TYPE} too large: 1233 bytes (max: 1232 bytes)`,
      });
      expect(await error(`${b64(1_233)}A`, 'base64', method)).toEqual({
        code: -32602,
        message: `base64 encoded ${TYPE} too large: 1645 bytes (max: encoded/raw 1644/1232)`,
      });
    }
    expect((await error('z'.repeat(1_682), 'base58'))?.message).toMatch(
      `failed to deserialize ${TYPE}: `,
    );
    expect(await error('z'.repeat(1_683), 'base58')).toEqual({
      code: -32602,
      message: `decoded ${TYPE} too large: 1233 bytes (max: 1232 bytes)`,
    });
    expect(await error('z'.repeat(1_684), 'base58')).toEqual({
      code: -32602,
      message: `base58 encoded ${TYPE} too large: 1684 bytes (max: encoded/raw 1683/1232)`,
    });
  }, 30_000);

  it("checks a blockhash's age in a simulation six blocks short, as agave forwards (M2)", async () => {
    const { node, rpc, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const blockhash = node.head.hash;
    const pay = (lamports: bigint) =>
      tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n + lamports)], {
        blockhash,
      });
    const simulated = async (raw: string) =>
      (
        (
          await rpc('simulateTransaction', [
            raw,
            { encoding: 'base64', commitment: 'confirmed' },
          ])
        ).result as { value: { err: unknown } }
      ).value.err;
    const fee = async () =>
      (
        (
          await rpc('getFeeForMessage', [
            Buffer.from(
              codec.compileMessage(KEY_ADDRESS, blockhash, [
                systemTransfer(KEY_ADDRESS, RECIPIENT, 1n),
              ]),
            ).toString('base64'),
            { commitment: 'confirmed' },
          ])
        ).result as { value: unknown }
      ).value;
    node.produce(144);
    expect(await simulated(pay(1n))).toBeNull();
    // Age 145: past 150 − 6 for a simulation, still within 150 for a leader.
    node.produce(1);
    expect(await simulated(pay(1n))).toBe('BlockhashNotFound');
    expect((await send(pay(2n))).error?.message).toBe(
      'Transaction simulation failed: Blockhash not found',
    );
    const id = (await send(pay(3n), { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    // getFeeForMessage knows every hash in the queue (300), not only the recent ones.
    node.produce(300 - 146);
    expect(await fee()).toBe(5_000);
    node.produce(1);
    expect(await fee()).toBeNull();
  });

  it('refuses `processed` where agave does, and a pruned skipped slot is cleaned up (M3)', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const main = node.endpoint('main');
    const pruned = node.endpoint('pruned', { firstAvailableHeight: 3 });
    node.produce(1);
    node.skip(1);
    node.produce(4);
    // Heights 0–5 sit at slots 0, 1, 3, 4, 5, 6: slot 2 was skipped.
    const call = async (url: string, method: string, params: unknown[]) =>
      (
        JSON.parse(
          await (
            await node.fetch.fetch(url, {
              method: 'POST',
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            })
          ).text(),
        ) as { error?: unknown }
      ).error;
    const processed = { commitment: 'processed' };
    const below = {
      code: -32602,
      message: 'Method does not support commitment below `confirmed`',
    };
    const signature = '1'.repeat(64);
    for (const [method, params] of [
      ['getBlock', [1, processed]],
      ['getBlocks', [0, 10, processed]],
      ['getTransaction', [signature, { ...processed, encoding: 'jsonParsed' }]],
      ['getSignaturesForAddress', [KEY_ADDRESS, processed]],
    ] as const) {
      expect(await call(main, method, [...params])).toEqual(below);
    }
    const header = { commitment: 'confirmed', transactionDetails: 'none' };
    expect(await call(pruned, 'getBlock', [2, header])).toEqual({
      code: -32001,
      message: 'Block 2 cleaned up, does not exist on node. First available block: 4',
    });
    expect(await call(main, 'getBlock', [2, header])).toMatchObject({ code: -32007 });
  });

  it("honours `encoding` as agave does: base58 unless told, accounts' binary under 128 bytes (M4)", async () => {
    const { node, rpc, tx } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const account = node.mintTo(MINT, KEY_ADDRESS, 5n);
    node.produce(1);
    const raw = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]);
    // A caller that drops `encoding: 'base64'` has its bytes read as base58, and fails.
    for (const method of ['sendTransaction', 'simulateTransaction']) {
      expect((await rpc(method, [raw, { commitment: 'confirmed' }])).error).toEqual({
        code: -32602,
        message: expect.stringMatching(
          /^(invalid base58 encoding: |failed to deserialize )/,
        ) as unknown,
      });
      expect((await rpc(method, [raw, { encoding: 'jsonParsed' }])).error).toEqual({
        code: -32602,
        message: 'unsupported encoding: jsonParsed. Supported encodings: base58, base64',
      });
    }
    const base58Raw = base58.encode(Buffer.from(raw, 'base64'));
    const simulate = (data: string, config: Record<string, unknown>) =>
      rpc('simulateTransaction', [data, { commitment: 'confirmed', ...config }]);
    expect(await simulate(base58Raw, {})).toMatchObject({
      result: { value: { err: null } },
    });
    expect(
      await simulate(raw, {
        encoding: 'base64',
        replaceRecentBlockhash: true,
        sigVerify: true,
      }),
    ).toMatchObject({
      error: {
        code: -32602,
        message: 'sigVerify may not be used with replaceRecentBlockhash',
      },
    });
    const stale = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)], {
      blockhash: node.block(0n)?.hash,
    });
    node.produce(2);
    expect(
      await simulate(stale, { encoding: 'base64', replaceRecentBlockhash: true }),
    ).toMatchObject({
      result: {
        value: {
          err: null,
          replacementBlockhash: {
            blockhash: node.head.hash,
            lastValidBlockHeight: Number(node.head.height) + 150,
          },
        },
      },
    });
    // Accounts: legacy base58 text by default, refused above 128 bytes.
    const info = async (address: string, encoding?: string) =>
      rpc('getAccountInfo', [address, { commitment: 'confirmed', encoding }]);
    const mintBytes = Buffer.from(node.account(MINT)?.data ?? []);
    expect((await info(MINT)).result).toMatchObject({
      value: { data: base58.encode(mintBytes) },
    });
    expect((await info(MINT, 'base58')).result).toMatchObject({
      value: { data: [base58.encode(mintBytes), 'base58'] },
    });
    const tooLong = {
      code: -32600,
      message:
        'Encoded binary (base 58) data should be less than 128 bytes, please use Base64 encoding.',
    };
    expect((await info(account)).error).toEqual(tooLong);
    expect((await info(account, 'base64')).result).toMatchObject({
      value: { data: [expect.any(String), 'base64'], space: 165 },
    });
    const accounts = (encoding?: string) =>
      rpc('getTokenAccountsByOwner', [
        KEY_ADDRESS,
        { mint: MINT },
        { commitment: 'confirmed', encoding },
      ]);
    expect((await accounts()).error).toEqual(tooLong);
    expect((await accounts('base64')).result).toMatchObject({
      value: [{ pubkey: account }],
    });
  });

  it('accepts only what the codec produces (M6)', async () => {
    const { node, rpc, tx } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const refused = async (raw: string | Uint8Array) =>
      (
        await rpc('sendTransaction', [
          typeof raw === 'string' ? raw : Buffer.from(raw).toString('base64'),
          { encoding: 'base64', skipPreflight: true },
        ])
      ).error;
    const transfer = systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n);
    const message = codec.compileMessage(KEY_ADDRESS, node.head.hash, [transfer]);
    const signature = sign(message);
    const bytes = signedTransaction([signature], message);
    const sanitize = {
      code: -32602,
      message:
        'invalid transaction: Transaction failed to sanitize accounts offsets correctly',
    };
    // Signatures must match the header's count, even without preflight.
    expect(await refused(signedTransaction([signature, signature], message))).toEqual(
      sanitize,
    );
    expect(await refused(signedTransaction([], message))).toEqual(sanitize);
    // A non-canonical length (0x81 0x00 is 1) and trailing bytes are not the codec's.
    const alias = Uint8Array.from([0x81, 0x00, ...bytes.subarray(1)]);
    expect((await refused(alias))?.message).toMatch(`failed to deserialize ${TYPE}: `);
    expect((await refused(Uint8Array.from([...bytes, 0])))?.message).toMatch(
      `failed to deserialize ${TYPE}: `,
    );
    // Versioned messages are not the codec's either.
    const v0 = new TransactionMessage({
      payerKey: new PublicKey(KEY_ADDRESS),
      recentBlockhash: node.head.hash,
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey(transfer.programId),
          keys: transfer.accounts.map((a) => ({
            pubkey: new PublicKey(a.address),
            isSigner: a.signer,
            isWritable: a.writable,
          })),
          data: Buffer.from(transfer.data),
        }),
      ],
    })
      .compileToV0Message()
      .serialize();
    expect(await refused(signedTransaction([sign(v0)], v0))).toEqual({
      code: -32602,
      message: 'invalid transaction: Transaction version is unsupported',
    });
    // agave reads the compute budget when it sanitizes: one instruction of each kind.
    expect(
      await refused(
        tx([setComputeUnitLimit(1_000n), setComputeUnitLimit(2_000n), transfer]),
      ),
    ).toEqual({
      code: -32602,
      message:
        'invalid transaction: Transaction contains a duplicate instruction (1) that is not allowed',
    });
    const junk = {
      programId: 'ComputeBudget111111111111111111111111111111',
      accounts: [],
      data: Uint8Array.of(9),
    };
    expect(await refused(tx([junk, transfer]))).toEqual({
      code: -32602,
      message:
        'invalid transaction: Error processing Instruction 0: invalid instruction data',
    });
    expect(await refused(bytes)).toBeUndefined();
  });

  it("knows each mint's token program, and the ATA program's accounts (M7)", async () => {
    const { node, rpc, tx, send } = setup();
    const MINT_2022 = DEVNET_GENESIS;
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    node.createMint(MINT_2022, 6, TOKEN_2022);
    const account = node.mintTo(MINT_2022, KEY_ADDRESS, 5n);
    node.produce(1);
    expect(account).toBe(associatedAddress(KEY_ADDRESS, MINT_2022, TOKEN_2022));
    expect(node.account(account)?.owner).toBe(TOKEN_2022);
    expect(node.tokenBalance(MINT_2022, KEY_ADDRESS)).toBe(5n);
    const error = async (raw: string) =>
      (await send(raw)).error?.message.replace(
        'Transaction simulation failed: Error processing Instruction 0: ',
        '',
      );
    const create = (mint: string, program = TOKEN, system = SYSTEM) => {
      const ix = createAssociatedTokenAccountIdempotent(
        KEY_ADDRESS,
        associatedAddress(RECIPIENT, mint, program),
        RECIPIENT,
        mint,
      );
      const swap = [system, program];
      return {
        ...ix,
        accounts: ix.accounts.map((a, i) =>
          i >= 4 ? { ...a, address: swap[i - 4] as string } : a,
        ),
      };
    };
    // The classic program refuses a Token-2022 mint, and the program must be the mint's.
    expect(await error(tx([create(MINT_2022)]))).toBe(
      'incorrect program id for instruction',
    );
    expect(await error(tx([create(MINT, TOKEN_2022)]))).toBe(
      'incorrect program id for instruction',
    );
    // The address is derived with the program passed.
    const wrong = createAssociatedTokenAccountIdempotent(
      KEY_ADDRESS,
      associatedAddress(RECIPIENT, MINT, TOKEN_2022),
      RECIPIENT,
      MINT,
    );
    expect(await error(tx([wrong]))).toBe(
      'Provided seeds do not result in a valid address',
    );
    expect(await error(tx([create(MINT, TOKEN, MEMO)]))).toBe(
      'An account required by the instruction is missing',
    );
    expect(await error(tx([create(MINT)]))).toBeUndefined();
    // getTokenAccountsByOwner lists by the mint's program, and checks its filter.
    const list = async (filter: Record<string, string>) =>
      rpc('getTokenAccountsByOwner', [
        KEY_ADDRESS,
        filter,
        { commitment: 'confirmed', encoding: 'base64' },
      ]);
    expect((await list({ programId: TOKEN_2022 })).result).toMatchObject({
      value: [{ pubkey: account }],
    });
    expect((await list({ programId: TOKEN })).result).toMatchObject({ value: [] });
    expect((await list({ mint: MINT_2022 })).result).toMatchObject({
      value: [{ pubkey: account }],
    });
    for (const [filter, message] of [
      [{ programId: MEMO }, 'Invalid param: unrecognized Token program id'],
      [{ mint: RECIPIENT }, 'Invalid param: could not find mint'],
      [{ mint: KEY_ADDRESS }, 'Invalid param: Token mint could not be unpacked'],
    ] as const) {
      expect((await list(filter)).error).toEqual({ code: -32602, message });
    }
  });

  it('quotes prioritization fees as exact u64s, one per recent block (M8)', async () => {
    const node = new ScriptedSolanaNode({
      clock: new FakeClock(),
      prioritizationFees: [2n ** 64n - 1_000n, 5, 7n],
    });
    const url = node.endpoint('main');
    node.produce(1);
    node.skip(2);
    // Two blocks exist (slots 0 and 1): three fees, two answers, no negative or skipped slot.
    const text = await (
      await node.fetch.fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getRecentPrioritizationFees',
          params: [],
        }),
      })
    ).text();
    expect(text).toBe(
      '{"jsonrpc":"2.0","id":1,"result":[{"prioritizationFee":18446744073709550616,"slot":1},{"prioritizationFee":5,"slot":0}]}',
    );
  });

  it('runs a program out of compute units as agave does: builtins exceed, programs fail to complete (M5)', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    const destination = node.mintTo(MINT, RECIPIENT, 0n);
    node.produce(1);
    const starved = (ix: SolanaInstruction) => tx([setComputeUnitLimit(200n), ix]);
    const land = async (raw: string) => {
      const id = (await send(raw, { skipPreflight: true })).result as string;
      node.produce(1);
      return node.landed(id)?.err;
    };
    const failed = { InstructionError: [1, 'ProgramFailedToComplete'] };
    expect(
      await land(starved(transferChecked(source, MINT, destination, KEY_ADDRESS, 1n, 6))),
    ).toEqual(failed);
    expect(await land(starved(memo('hello')))).toEqual(failed);
    expect(await land(starved(systemTransfer(KEY_ADDRESS, RECIPIENT, 1n)))).toEqual({
      InstructionError: [1, 'ComputationalBudgetExceeded'],
    });
    expect((await send(starved(memo('again')))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: Program failed to complete',
    );
  });

  it('lists a block by its signatures', async () => {
    const { node, rpc, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const id = (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)])))
      .result as string;
    node.produce(1);
    expect(
      (
        await rpc('getBlock', [
          Number(node.head.slot),
          { commitment: 'confirmed', transactionDetails: 'signatures' },
        ])
      ).result,
    ).toEqual({
      blockHeight: 2,
      blockTime: node.head.blockTime,
      blockhash: node.head.hash,
      parentSlot: 1,
      previousBlockhash: node.block(1n)?.hash,
      signatures: [id],
    });
  });

  it('names its first available block, and knows the native mint, as agave does (Task 6)', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const urls = {
      main: node.endpoint('main'),
      pruned: node.endpoint('pruned', { firstAvailableHeight: 3 }),
      bt: node.endpoint('bt', { bigtableFailsBelow: 4n }),
    };
    node.skip(2);
    node.produce(6);
    const call = async (url: string, method: string, params: unknown[] = []) =>
      JSON.parse(
        await (
          await node.fetch.fetch(url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).text(),
      ) as { result?: unknown; error?: { code: number; message: string } };
    // agave `get_first_available_block` (rpc.rs, v4.3.0 825efd1): the local ledger's first
    // block, or long-term storage's when that answers with a lower one.
    expect((await call(urls.main, 'getFirstAvailableBlock')).result).toBe(0);
    expect((await call(urls.pruned, 'getFirstAvailableBlock')).result).toBe(
      Number(node.block(3n)?.slot),
    );
    expect((await call(urls.bt, 'getFirstAvailableBlock')).result).toBe(
      Number(node.block(4n)?.slot),
    );
    // agave `get_mint_owner_and_additional_data` (parsed_token_accounts.rs): the native
    // mint is the Token program's without reading its account.
    const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    const list = (owner: string) =>
      call(urls.main, 'getTokenAccountsByOwner', [
        owner,
        { mint: NATIVE_MINT },
        { commitment: 'confirmed', encoding: 'base64' },
      ]);
    expect(node.account(NATIVE_MINT)).toBeUndefined();
    expect((await list(RECIPIENT)).result).toMatchObject({ value: [] });
    const wrapped = node.mintTo(NATIVE_MINT, KEY_ADDRESS, 5n);
    expect((await list(KEY_ADDRESS)).result).toMatchObject({
      value: [{ pubkey: wrapped }],
    });
  });

  it('answers faults at the HTTP level: a Retry-After, a gateway error, a hang until aborted', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const url = node.endpoint('main');
    const post = (method: string, signal?: AbortSignal) =>
      node.fetch.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: [] }),
        ...(signal ? { signal } : {}),
      });
    node.intercept = () => faults.rateLimited(2);
    const limited = await post('getSlot');
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '2']);
    node.intercept = () => faults.unhealthy(42);
    expect(JSON.parse(await (await post('getSlot')).text())).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32005,
        message: 'Node is behind by 42 slots',
        data: { numSlotsBehind: 42 },
      },
    });
    for (const [status, text] of [
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [503, 'Service Unavailable'],
      [504, 'Gateway Timeout'],
    ] as const) {
      node.intercept = () => faults.serverError(status);
      const answer = await post('getSlot');
      expect([answer.status, answer.statusText, await answer.text()]).toEqual([
        status,
        text,
        text,
      ]);
    }
    // An endpoint that answers its probes and fails everything else is an intercept by method.
    node.intercept = (_endpoint, method) =>
      method === 'getGenesisHash' ? undefined : faults.serverError();
    expect(await (await post('getGenesisHash')).text()).toContain(DEVNET_GENESIS);
    expect((await post('getBalance')).status).toBe(503);
    node.intercept = () => faults.timeout;
    const controller = new AbortController();
    const hung = post('getSlot', controller.signal);
    controller.abort(new Error('timed out'));
    await expect(hung).rejects.toThrow('timed out');
  });
});

describe('the scripted Solana node behind a real transport', () => {
  it('refuses broadcasts in the shapes the classifier reads: code, text and simulation err', async () => {
    const t = nodeTransport();
    const { node } = t;
    node.fund(KEY_ADDRESS, 10_000_000n);
    node.fund(RECIPIENT, 1_000n);
    node.produce(3);
    const broadcast = async (raw: string, preflightCommitment = 'confirmed') => {
      try {
        return await t.run(
          t.transport.rpc(
            'sendTransaction',
            [raw, { encoding: 'base64', preflightCommitment }],
            { ...BROADCAST, exactIntegers: true },
          ),
        );
      } catch (error) {
        const e = error as CryptoAioError;
        const data = e.details?.rpcData;
        let err: unknown = 'cut by the transport';
        try {
          err = (JSON.parse(String(data)) as { err: unknown }).err;
        } catch {
          // Past 512 characters the data is cut, and the text decides.
        }
        return { err, verdict: classifyBroadcastError(rpcCode(e), rpcMessage(e), data) };
      }
    };
    const pay = (lamports: bigint, key?: string) =>
      signedTx(
        node.head.hash,
        [systemTransfer(KEY_ADDRESS, RECIPIENT, lamports)],
        key ? { key } : {},
      );
    const refused = (code: string, reason: string) => ({ kind: 'refused', code, reason });
    const forged = pay(2_000_000n, RECIPIENT_KEY);
    // agave 4.3.0's simulation result, whole: it fits the transport's 512-character cut.
    await expect(
      t.run(
        t.transport.rpc('sendTransaction', [forged, { encoding: 'base64' }], BROADCAST),
      ),
    ).rejects.toMatchObject({
      details: {
        rpcCode: -32002,
        rpcData: JSON.stringify({
          accounts: null,
          err: 'SignatureFailure',
          fee: null,
          innerInstructions: null,
          loadedAccountsDataSize: 0,
          loadedAddresses: null,
          logs: [],
          postBalances: null,
          postTokenBalances: null,
          preBalances: null,
          preTokenBalances: null,
          replacementBlockhash: null,
          returnData: null,
          unitsConsumed: 0,
        }),
      },
    });
    expect(await broadcast(forged)).toEqual({
      err: 'SignatureFailure',
      verdict: { kind: 'rejected', reason: 'invalid signature' },
    });
    expect(await broadcast(pay(2_000_000n), 'finalized')).toEqual({
      err: 'BlockhashNotFound',
      verdict: refused('TX_REFUSED', 'blockhash not found'),
    });
    expect(await broadcast(pay(1_000n))).toEqual({
      err: { InsufficientFundsForRent: { account_index: 1 } },
      verdict: refused('INSUFFICIENT_FUNDS', 'insufficient funds for rent'),
    });
    expect(await broadcast(pay(20_000_000n))).toEqual({
      err: { InstructionError: [0, { Custom: 1 }] },
      verdict: refused('INSUFFICIENT_FUNDS', 'insufficient funds'),
    });
    const poor = signedTx(node.head.hash, [systemTransfer(RECIPIENT, KEY_ADDRESS, 1n)], {
      payer: RECIPIENT,
      key: RECIPIENT_KEY,
    });
    expect(await broadcast(poor)).toEqual({
      err: 'InsufficientFundsForFee',
      verdict: refused('INSUFFICIENT_FUNDS', 'insufficient funds for fee'),
    });
    const good = pay(2_000_000n);
    expect(await broadcast(good)).toEqual(expect.any(String));
    node.produce(1);
    expect(await broadcast(good)).toEqual({
      err: 'AlreadyProcessed',
      verdict: { kind: 'already-known' },
    });
  });

  it("logs like agave, so a long failure outgrows the transport's data cut and its text decides (M10)", async () => {
    const t = nodeTransport();
    const { node } = t;
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    const destination = node.mintTo(MINT, RECIPIENT, 0n);
    node.produce(1);
    const budget = 'ComputeBudget111111111111111111111111111111';
    const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const params = [
      signedTx(node.head.hash, [
        setComputeUnitLimit(50_000n),
        setComputeUnitPrice(1n),
        transferChecked(source, MINT, destination, KEY_ADDRESS, 6_000_000n, 6),
      ]),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ];
    const error = (await t
      .run(t.transport.rpc('sendTransaction', params, BROADCAST))
      .catch((e: unknown) => e)) as CryptoAioError;
    const data = String(error.details?.rpcData);
    expect(data).toHaveLength(512);
    expect(() => JSON.parse(data) as unknown).toThrow();
    expect(
      classifyBroadcastError(rpcCode(error), rpcMessage(error), error.details?.rpcData),
    ).toEqual({
      kind: 'refused',
      code: 'INSUFFICIENT_FUNDS',
      reason: 'insufficient funds',
    });
    const whole = JSON.parse(
      await (
        await node.fetch.fetch('https://main.solana.test/', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params,
          }),
        })
      ).text(),
    ) as { error: { data: { logs: string[]; fee: number; unitsConsumed: number } } };
    expect(whole.error.data).toMatchObject({
      fee: 5_001,
      unitsConsumed: 405,
      logs: [
        `Program ${budget} invoke [1]`,
        `Program ${budget} success`,
        `Program ${budget} invoke [1]`,
        `Program ${budget} success`,
        `Program ${token} invoke [1]`,
        'Program log: Instruction: TransferChecked',
        'Program log: Error: insufficient funds',
        `Program ${token} consumed 105 of 49700 compute units`,
        `Program ${token} failed: custom program error: 0x1`,
      ],
    });
    // A landed transaction keeps its logs in its meta.
    const id = await t.run(
      t.transport.rpc<string>(
        'sendTransaction',
        [
          signedTx(node.head.hash, [memo('hello')]),
          { encoding: 'base64', preflightCommitment: 'confirmed' },
        ],
        BROADCAST,
      ),
    );
    node.produce(1);
    const landed = await t.run(
      t.transport.rpc<{ meta: { logMessages: string[] } }>(
        'getTransaction',
        [id, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        READ,
      ),
    );
    const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
    expect(landed.meta.logMessages).toEqual([
      `Program ${memoProgram} invoke [1]`,
      'Program log: Memo (len 5): "hello"',
      `Program ${memoProgram} consumed 12125 of 200000 compute units`,
      `Program ${memoProgram} success`,
    ]);
  });

  it('builds its transport with a fixed id and fixed jitter (lesson 1, R46)', async () => {
    const random = jest.spyOn(Math, 'random');
    try {
      const t = nodeTransport({}, ['a', 'b']);
      t.node.intercept = (endpoint) =>
        endpoint === 'a' ? faults.serverError() : undefined;
      await t.run(t.transport.rpc('getBlockHeight', [{ commitment: 'confirmed' }], READ));
      expect(t.transport.id).toBe('solana-test');
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it('lets an intercept lie for one endpoint, starting from the node’s own answer', async () => {
    const t = nodeTransport({}, ['a', 'b']);
    t.node.produce(3);
    t.node.intercept = (endpoint, method, params) => {
      if (endpoint !== 'b' || method !== 'getBlock') return undefined;
      const block = t.node.answer(endpoint, method, params) as Record<string, unknown>;
      return { result: { ...block, blockhash: DEVNET_GENESIS } };
    };
    const read = () =>
      t.run(
        t.transport.rpc(
          'getBlock',
          [2, { commitment: 'confirmed', transactionDetails: 'none' }],
          { ...READ, quorum: 2 },
        ),
      );
    await expect(read()).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    t.node.intercept = undefined;
    await expect(read()).resolves.toMatchObject({ blockHeight: 2 });
  });
});
