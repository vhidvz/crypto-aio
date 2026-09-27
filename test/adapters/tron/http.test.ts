import { sha256 } from '@noble/hashes/sha256';
import {
  BROADCAST,
  MONITOR,
  PROOF,
  READ,
  historyPage,
  quorumKeyFor,
} from '../../../src/adapters/tron/http';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import type { FakeReply } from '../../../src/testing/fake-fetch';
import { nodeTransport } from './support/harness';
import { signedTransaction } from './support/signing';
import { KEY_ADDRESS, KEY_HEX, RECIPIENT_HEX, USDT, USDT_HEX } from './support/vectors';

describe('TronApi', () => {
  it('sends every request straight to the transport with the caller tags (R41)', async () => {
    const h = nodeTransport();
    h.node.fund(KEY_ADDRESS, 5n);
    await h.run(h.api.account(KEY_HEX, READ));
    await h.run(h.api.block('solid', undefined, MONITOR));
    await h.run(h.api.block('solid', 0n, PROOF));
    await h.run(h.api.transactionInfo('solid', '00'.repeat(32), PROOF));
    expect(h.calls).toEqual([
      {
        path: '/wallet/getaccount',
        tags: { purpose: 'read', retry: 'safe', exactIntegers: true },
      },
      {
        path: '/walletsolidity/getblock',
        tags: { purpose: 'monitor', retry: 'safe', exactIntegers: true },
      },
      {
        path: '/walletsolidity/getblock',
        tags: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          exactIntegers: true,
          quorumKey: true,
        },
      },
      {
        path: '/walletsolidity/gettransactioninfobyid',
        tags: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          exactIntegers: true,
          quorumKey: true,
        },
      },
    ]);
  });

  it('parses accounts, resources, parameters and blocks', async () => {
    const h = nodeTransport();
    expect(await h.run(h.api.account(KEY_HEX, READ))).toEqual({
      exists: false,
      balance: 0n,
    });
    h.node.fund(KEY_ADDRESS, 7n);
    h.node.stake(KEY_ADDRESS, { energy: 50n });
    expect(await h.run(h.api.account(KEY_HEX, READ))).toEqual({
      exists: true,
      balance: 7n,
    });
    expect(await h.run(h.api.resources(KEY_HEX, READ))).toEqual({
      activated: true,
      freeBandwidth: 600n,
      stakedBandwidth: 0n,
      energy: 50n,
    });
    expect(await h.run(h.api.chainParameters(READ))).toMatchObject({
      transactionFee: 1_000n,
      energyFee: 100n,
      memoFee: 1_000_000n,
      maxFeeLimit: 15_000_000_000n,
    });
    const genesis = await h.run(h.api.block('full', 0n, READ));
    expect(genesis?.id).toBe(
      '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
    );
    expect(await h.run(h.api.block('full', 99n, READ))).toBeNull();
  });

  it('classifies token calls: ok, failed, no contract, and other refusals (lesson 13)', async () => {
    const h = nodeTransport();
    h.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    h.node.deployToken(RECIPIENT_HEX, {
      symbol: 'BAD',
      decimals: 6,
      mode: 'reverting-metadata',
    });
    expect(
      await h.run(h.api.constantCall(KEY_HEX, USDT_HEX, '313ce567', READ)),
    ).toMatchObject({
      kind: 'ok',
      result: '6'.padStart(64, '0'),
    });
    expect(
      await h.run(h.api.constantCall(KEY_HEX, RECIPIENT_HEX, '313ce567', READ)),
    ).toMatchObject({
      kind: 'failed',
    });
    expect(await h.run(h.api.constantCall(KEY_HEX, KEY_HEX, '313ce567', READ))).toEqual({
      kind: 'no-contract',
    });
    h.node.intercept('main', '/wallet/triggerconstantcontract', () => ({
      json: { result: { code: 'OTHER_ERROR', message: '6f6f7073' } },
    }));
    await expect(
      h.run(h.api.constantCall(KEY_HEX, USDT_HEX, '313ce567', READ)),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: true,
    });
  });

  it('turns malformed and error answers into retryable provider errors that repeat no node text', async () => {
    const h = nodeTransport();
    h.node.intercept('main', '/wallet/getaccount', () => ({
      json: { address: KEY_HEX, balance: -1 },
    }));
    await expect(h.run(h.api.account(KEY_HEX, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.intercept('main', '/wallet/getaccountresource', () => ({
      json: { Error: 'class java.lang.IllegalArgumentException : TXYZ secret' },
    }));
    const error = await h.run(h.api.resources(KEY_HEX, READ)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RPC_ERROR', retryable: true });
    expect(String((error as Error).message)).not.toMatch(/TXYZ|java/);
  });

  it('decides nothing when a fixed solidified block is not solidified on every endpoint (lesson 17)', async () => {
    const h = nodeTransport({ solidDepth: 2 }, ['a', 'b']);
    for (let i = 0; i < 6; i++) h.node.mine();
    h.node.lag('b', 3);
    const f = (await h.run(h.api.block('solid', undefined, MONITOR)))?.number as bigint;
    expect(f).toBe(4n);
    await expect(h.run(h.api.block('solid', f, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.lag('b', 0);
    expect((await h.run(h.api.block('solid', f, PROOF)))?.number).toBe(4n);
    // A caller quorumKey (a monotone predicate) replaces the path's default consensus key.
    h.node.lag('b', 1);
    const passed = await h.run(
      h.api.block('solid', undefined, { ...PROOF, quorumKey: () => 'same fact' }),
    );
    expect(passed?.number).toBe(4n);
  });

  it('compares only consensus facts under a quorum, and the logs a verdict reads (R59)', () => {
    const key = quorumKeyFor('/walletsolidity/gettransactioninfobyid');
    const info = {
      id: 'AA',
      blockNumber: 3,
      receipt: { result: 'SUCCESS', energy_usage: 5 },
      log: [{ address: 'BB', topics: ['CC'], data: 'DD' }],
    };
    expect(
      key?.({ ...info, fee: 9, receipt: { ...info.receipt, energy_usage: 6 } }),
    ).toEqual(key?.(info));
    expect(key?.({ ...info, log: [] })).not.toEqual(key?.(info));
    expect(quorumKeyFor('/wallet/getaccount')).toBeUndefined();
    // The negative scan stops on a block's timestamp, so the JSON-RPC key compares it (F4).
    const rpc = quorumKeyFor('/jsonrpc');
    const block = {
      number: '0x5',
      hash: '0xAA',
      parentHash: '0xBB',
      timestamp: '0x10',
      transactions: [],
    };
    expect(rpc?.({ result: { ...block, size: '0x1' } })).toEqual(
      rpc?.({ result: block }),
    );
    expect(rpc?.({ result: { ...block, timestamp: '0x1' } })).not.toEqual(
      rpc?.({ result: block }),
    );
  });

  it('tells an error answer from an empty one without comparing error text (lesson 18)', () => {
    for (const path of [
      '/walletsolidity/getblock',
      '/walletsolidity/gettransactioninfobyid',
      '/walletsolidity/gettransactionbyid',
    ]) {
      const key = quorumKeyFor(path);
      expect(key?.({ Error: 'java.lang.NullPointerException' })).not.toEqual(key?.({}));
      expect(key?.({ Error: 'one text' })).toEqual(key?.({ Error: 'another text' }));
    }
    const rpc = quorumKeyFor('/jsonrpc');
    expect(rpc?.({ error: { code: -32000, message: 'x' } })).not.toEqual(
      rpc?.({ result: null }),
    );
    // proto3 JSON omits block 0's number: absent and 0 are the same fact.
    const header = quorumKeyFor('/walletsolidity/getblock');
    const raw = { parentHash: 'BB', timestamp: 7 };
    expect(header?.({ blockID: 'AA', block_header: { raw_data: raw } })).toEqual(
      header?.({ blockID: 'aa', block_header: { raw_data: { ...raw, number: 0 } } }),
    );
  });

  it('reads amounts above 2^53 exactly (A12)', async () => {
    const h = nodeTransport();
    h.node.fund(KEY_ADDRESS, 10_000_000_000_000_000_000n);
    expect(await h.run(h.api.account(KEY_HEX, READ))).toEqual({
      exists: true,
      balance: 10_000_000_000_000_000_000n,
    });
  });

  it('broadcasts hex and reads pending and included transactions', async () => {
    const h = nodeTransport();
    h.node.fund(KEY_ADDRESS, 10_000_000n);
    const block = h.node.block(0) as { id: string; timestamp: number };
    const tx = signedTransaction({
      refBlockBytes: block.id.slice(12, 16),
      refBlockHash: block.id.slice(16, 32),
      expiration: block.timestamp + 60_000,
      timestamp: block.timestamp,
      contract: {
        type: 'TransferContract',
        owner: KEY_HEX,
        to: RECIPIENT_HEX,
        amount: 1n,
      },
    });
    expect(
      await h.run(
        h.api.broadcastHex(tx.hex, {
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
        }),
      ),
    ).toEqual({
      accepted: true,
    });
    expect(await h.run(h.api.pending(tx.id, MONITOR))).toMatchObject({ id: tx.id });
    h.node.mine();
    expect(await h.run(h.api.transaction('full', tx.id, READ))).toMatchObject({
      id: tx.id,
      contractRet: 'SUCCESS',
    });
    expect(await h.run(h.api.transactionInfo('solid', tx.id, READ))).toBeNull();
    expect(await h.run(h.api.rpcBlock(1n, READ))).toMatchObject({
      number: 1n,
      transactions: [tx.id],
    });
  });

  it("reads a block with its receipts, and refuses receipts that are not exactly the block's", async () => {
    const h = nodeTransport();
    h.node.fund(KEY_ADDRESS, 10_000_000n);
    const genesis = h.node.block(0) as { id: string; timestamp: number };
    const transfer = (amount: bigint) =>
      signedTransaction({
        refBlockBytes: genesis.id.slice(12, 16),
        refBlockHash: genesis.id.slice(16, 32),
        expiration: genesis.timestamp + 60_000,
        timestamp: genesis.timestamp,
        contract: { type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount },
      });
    const a = transfer(1n);
    const b = transfer(2n);
    await h.run(h.api.broadcastHex(a.hex, BROADCAST));
    await h.run(h.api.broadcastHex(b.hex, BROADCAST));
    h.node.mine();
    const read = await h.run(h.api.blockWithTransactions(1n, MONITOR));
    expect(read?.header.number).toBe(1n);
    expect(read?.transactions.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(read?.infos.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(read?.infos[0]?.fee).toBeGreaterThan(0n);
    expect(await h.run(h.api.blockWithTransactions(2n, MONITOR))).toBeNull();
    // As many receipts as transactions, but two for `a` and none for `b`.
    const at = read?.header.timestamp;
    h.node.intercept('main', '/wallet/gettransactioninfobyblocknum', () => ({
      json: [a.id, a.id].map((id) => ({ id, blockNumber: 1, blockTimeStamp: at })),
    }));
    await expect(h.run(h.api.blockWithTransactions(1n, MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('binds every answer to what was asked: ids hash their bytes, blocks match their reference', async () => {
    const h = nodeTransport();
    const id = 'ab'.repeat(32);
    h.node.intercept('main', '/wallet/gettransactionbyid', () => ({
      json: { txID: id, raw_data_hex: '0a02abcd' },
    }));
    await expect(h.run(h.api.transaction('full', id, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.mine();
    const header = (timestamp: bigint): FakeReply => ({
      json: {
        blockID: '00'.repeat(32),
        block_header: { raw_data: { number: 1, parentHash: '00'.repeat(32), timestamp } },
      },
    });
    let block = header(3n);
    h.node.intercept('main', '/wallet/getblock', () => block);
    await expect(h.run(h.api.block('full', 0n, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    // A block time is never rounded: above 2^53 it is malformed.
    block = header(2n ** 60n);
    await expect(h.run(h.api.block('full', 1n, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    // Lesson 20: an oversized quantity is refused before it is converted, even when its
    // value is the one asked for.
    h.node.intercept('main', '/jsonrpc', () => ({
      json: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          number: `0x${'0'.repeat(100_000)}1`,
          hash: `0x${id}`,
          parentHash: `0x${id}`,
          timestamp: '0x1',
          transactions: [],
        },
      },
    }));
    await expect(h.run(h.api.rpcBlock(1n, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    // Raw bytes above java-tron's 500 KiB cap are malformed even when the id binds them.
    const big = '00'.repeat(500 * 1024 + 1);
    const bigId = toHex(sha256(fromHex(big)));
    const g = nodeTransport();
    g.node.intercept('main', '/wallet/gettransactionbyid', () => ({
      json: { txID: bigId, raw_data_hex: big },
    }));
    await expect(g.run(g.api.transaction('full', bigId, READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('decides nothing on a proof path when the endpoints refuse (lesson 18); reads pass errors through', async () => {
    const h = nodeTransport();
    const id = 'ab'.repeat(32);
    h.node.intercept('main', '/walletsolidity/gettransactioninfobyid', () => ({
      status: 404,
      text: 'Not Found',
    }));
    await expect(h.run(h.api.transactionInfo('solid', id, PROOF))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(h.run(h.api.transactionInfo('solid', id, READ))).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
    });
    const other = nodeTransport();
    other.node.intercept('main', '/wallet/getaccount', () => ({
      status: 401,
      text: 'unauthorized',
    }));
    await expect(other.run(other.api.account(KEY_HEX, READ))).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
      retryable: false,
    });
  });

  it('marks a broadcast answer it cannot read as possibly sent', async () => {
    const h = nodeTransport();
    let reply: FakeReply = { json: { result: false } };
    h.node.intercept('main', '/wallet/broadcasthex', () => reply);
    await expect(h.run(h.api.broadcastHex('00', BROADCAST))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      ambiguous: true,
    });
    reply = { json: { Error: 'class java.lang.NullPointerException' } };
    await expect(h.run(h.api.broadcastHex('00', BROADCAST))).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: true,
      ambiguous: true,
    });
    reply = {
      json: { result: false, code: 'SIGERROR', message: '536967206572726f72' },
    };
    expect(await h.run(h.api.broadcastHex('00', BROADCAST))).toEqual({
      accepted: false,
      code: 'SIGERROR',
      message: 'Sig error',
    });
  });

  it('never sends a quorum key without a quorum', async () => {
    const h = nodeTransport();
    await h.run(h.api.block('full', undefined, { ...MONITOR, quorumKey: () => 1 }));
    await h.run(
      historyPage(
        h.transport,
        KEY_ADDRESS,
        'transactions',
        { limit: 1 },
        { ...READ, quorumKey: () => 1 },
      ),
    );
    expect(h.calls.map((c) => c.tags.quorumKey)).toEqual([undefined, undefined]);
  });

  it('pages TronGrid history for both streams', async () => {
    const h = nodeTransport({ solidDepth: 0 });
    const page = await h.run(
      historyPage(h.transport, KEY_ADDRESS, 'transactions', { limit: 5 }, READ),
    );
    expect(page).toEqual({ ids: [] });
    expect(h.calls.at(-1)?.path).toBe(`/v1/accounts/${KEY_ADDRESS}/transactions`);
  });

  it('lists each transaction once per page, and refuses a malformed address before any call', async () => {
    const h = nodeTransport();
    const id = 'ab'.repeat(32);
    h.node.intercept('main', `/v1/accounts/${KEY_ADDRESS}/transactions/trc20`, () => ({
      json: {
        success: true,
        data: [{ transaction_id: id }, { transaction_id: id.toUpperCase() }],
        meta: { fingerprint: 'next' },
      },
    }));
    expect(
      await h.run(historyPage(h.transport, KEY_ADDRESS, 'trc20', { limit: 2 }, READ)),
    ).toEqual({ ids: [id], next: 'next' });
    const before = h.calls.length;
    for (const address of ['../../wallet/getaccount', `T${'1'.repeat(100_000)}`]) {
      await expect(
        h.run(historyPage(h.transport, address, 'transactions', { limit: 1 }, READ)),
      ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    }
    expect(h.calls).toHaveLength(before);
  });

  it('never waits on a real timer on a request path (R46)', async () => {
    const h = nodeTransport();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    try {
      await h.run(h.api.chainParameters(READ));
      await h.run(h.api.block('full', undefined, MONITOR));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(h.clock.pending).toBe(0);
  });
});
