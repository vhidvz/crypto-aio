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
import type { CryptoAioError } from '../../../src/core/errors/error';
import { FakeClock } from '../../../src/testing/fake-clock';
import { nodeTransport } from './support/harness';
import {
  DEVNET_GENESIS,
  ScriptedSolanaNode,
  associatedAddress,
  faults,
  type Scripted,
} from './support/node';
import { codec, signedTx } from './support/tx';
import { KEY_ADDRESS, MINT, RECIPIENT, RECIPIENT_KEY } from './support/vectors';

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
        return {
          err: (JSON.parse(String(data)) as { err: unknown }).err,
          verdict: classifyBroadcastError(rpcCode(e), rpcMessage(e), data),
        };
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
    try {
      await t.run(
        t.transport.rpc('sendTransaction', [forged, { encoding: 'base64' }], BROADCAST),
      );
    } catch (error) {
      // agave's simulation result, whole: it fits the transport's 512-character cut.
      expect(JSON.parse(String((error as CryptoAioError).details?.rpcData))).toEqual({
        accounts: null,
        err: 'SignatureFailure',
        innerInstructions: null,
        loadedAccountsDataSize: 0,
        logs: [],
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: 0,
      });
    }
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

  it('injects rate limits, unhealthy nodes, server errors and timeouts', async () => {
    // A short call timeout keeps the fake-time walk (and the real time it costs) small.
    const tags = { ...READ, timeoutMs: 1_000 };
    const read = async (fault: Scripted) => {
      const t = nodeTransport();
      t.node.intercept = () => fault;
      const error = (await t
        .run(t.transport.rpc('getBlockHeight', [{ commitment: 'confirmed' }], tags))
        .catch((e: unknown) => e)) as CryptoAioError;
      return { t, error: [error.code, error.message, error.details?.rpcCode] };
    };
    expect((await read(faults.rateLimited())).error).toEqual([
      'RATE_LIMITED',
      'endpoint rate limited (HTTP 429)',
      undefined,
    ]);
    expect((await read(faults.unhealthy(42))).error).toEqual([
      'RATE_LIMITED',
      'endpoint rate limited getBlockHeight',
      -32005,
    ]);
    expect((await read(faults.serverError(502))).error).toEqual([
      'PROVIDER_UNAVAILABLE',
      'endpoint error (HTTP 502)',
      undefined,
    ]);
    const { t, error } = await read(faults.timeout);
    expect(error.slice(0, 1)).toEqual(['TIMEOUT']);
    // Every attempt hung until the transport's timeout aborted it; no timer is left behind.
    expect([t.node.served.length, t.clock.pending]).toEqual([3, 0]);
    t.node.intercept = undefined;
    t.node.produce(2);
    expect(
      await t.run(t.transport.rpc('getBlockHeight', [{ commitment: 'confirmed' }], tags)),
    ).toBe(2);
  });

  it('scripts an endpoint that answers its probes but fails every request', async () => {
    const t = nodeTransport({}, ['a', 'b']);
    t.node.produce(2);
    const probes = new Set(['getGenesisHash', 'getBlockHeight']);
    t.transport.setProbes({
      identity: (call) => call.rpc<string>('getGenesisHash'),
      expectedIdentity: DEVNET_GENESIS,
      height: async (call) =>
        BigInt(await call.rpc<number>('getBlockHeight', [{ commitment: 'confirmed' }])),
    });
    t.node.intercept = (endpoint, method) =>
      endpoint === 'a' && !probes.has(method) ? faults.serverError() : undefined;
    for (let i = 0; i < 3; i++) {
      await t.clock.advance(20_000);
      expect(
        await t.run(
          t.transport.rpc('getBalance', [KEY_ADDRESS, { commitment: 'confirmed' }], READ),
        ),
      ).toMatchObject({ value: 0 });
    }
    const on = (endpoint: string) =>
      new Set(t.node.served.filter((s) => s.endpoint === endpoint).map((s) => s.method));
    // `a` passed its identity probe and failed every request, which `b` then served.
    expect(on('a')).toEqual(new Set(['getGenesisHash', 'getBalance']));
    expect(on('b').has('getBalance')).toBe(true);
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
