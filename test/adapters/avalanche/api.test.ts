import { sha256 } from '@noble/hashes/sha256';
import {
  DataApi,
  decodeChecked,
  encodeChecked,
  isHttpNotFound,
  isNodeNotFound,
  parseBlock,
  parseHeight,
  parsePlatformStatus,
} from '../../../src/adapters/avalanche/api';
import { cb58Encode } from '../../../src/adapters/avalanche/cb58';
import { classifyIssueError } from '../../../src/adapters/avalanche/errors';
import { ProviderError } from '../../../src/core/errors/error';
import { toHex } from '../../../src/core/util/bytes';
import { avalancheHarness } from './support/harness';
import { OTHER_BYTES } from './support/vectors';

const ID = cb58Encode(new Uint8Array(32).fill(3));
const ID2 = cb58Encode(new Uint8Array(32).fill(4));

describe('Avalanche answer parsers', () => {
  it('reads heights as numbers, bigints or decimal strings, and nothing else', () => {
    expect(parseHeight('12')).toBe(12n);
    expect(parseHeight(12)).toBe(12n);
    expect(parseHeight(12n)).toBe(12n);
    for (const bad of [
      '-1',
      '01',
      '1.5',
      1.5,
      -1,
      -1n,
      2n ** 60n,
      null,
      '9'.repeat(17),
    ]) {
      expect(() => parseHeight(bad)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    }
  });

  it('checks the hex checksum AvalancheGo adds', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const text = encodeChecked(bytes);
    expect(text).toBe(`0x${toHex(bytes)}${toHex(sha256(bytes).subarray(-4))}`);
    expect(decodeChecked(text, 'x')).toEqual(bytes);
    expect(() =>
      decodeChecked(text.replace(/.$/, text.endsWith('0') ? '1' : '0'), 'x'),
    ).toThrow('malformed Avalanche answer: x');
    for (const bad of ['0x01', toHex(bytes), '0xzz', 7]) {
      expect(() => decodeChecked(bad, 'x')).toThrow('malformed');
    }
  });

  it('reads every block shape: X-Chain, P-Chain standard, proposal and commit', () => {
    const block = (extra: Record<string, unknown>) => ({
      block: { id: ID, parentID: ID2, height: 7, ...extra },
    });
    expect(parseBlock(block({ time: 5, txs: [{ id: ID2 }] }))).toEqual({
      id: ID,
      parentId: ID2,
      height: 7n,
      timestamp: 5,
      txIds: [ID2],
    });
    // A Banff proposal block: its decision transactions, then its proposal transaction.
    expect(parseBlock(block({ txs: [], tx: { id: ID } })).txIds).toEqual([ID]);
    // An Apricot commit block: no time, no transactions.
    expect(parseBlock(block({}))).toEqual({
      id: ID,
      parentId: ID2,
      height: 7n,
      txIds: [],
    });
    for (const bad of [
      null,
      { block: null },
      block({ id: 'nope' }),
      block({ txs: 'x' }),
      block({ txs: [{ id: ID }, { id: ID }] }),
      block({ time: -1 }),
      block({ tx: { id: 5 } }),
    ]) {
      expect(() => parseBlock(bad)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    }
  });

  it('reads the P-Chain statuses', () => {
    for (const status of ['Committed', 'Aborted', 'Processing', 'Dropped', 'Unknown']) {
      expect(parsePlatformStatus({ status })).toBe(status);
    }
    expect(() => parsePlatformStatus({ status: 'Accepted' })).toThrow('malformed');
  });

  it('tells a definitive "not found" from every other error', () => {
    const rpc = (message: string, ambiguous = false) =>
      new ProviderError('RPC_ERROR', 'x', {
        ambiguous,
        details: { rpcCode: -32000, rpcMessage: message },
      });
    expect(isNodeNotFound(rpc('not found'))).toBe(true);
    expect(isNodeNotFound(rpc("couldn't get tx: not found"))).toBe(true);
    expect(isNodeNotFound(rpc("couldn't get block at height 9: not found"))).toBe(true);
    expect(isNodeNotFound(rpc('not found', true))).toBe(false);
    expect(isNodeNotFound(rpc('utxo not found in the mempool index'))).toBe(false);
    expect(isNodeNotFound(new Error('not found'))).toBe(false);
    const http = (status: number) =>
      new ProviderError('RPC_ERROR', 'x', { details: { status } });
    expect(isHttpNotFound(http(404))).toBe(true);
    expect(isHttpNotFound(http(400))).toBe(false);
  });

  it("reads the Data API's probes", () => {
    expect(DataApi.blockZero({ blockNumber: '0', blockHash: ID })).toBe(ID);
    expect(() => DataApi.blockZero({ blockNumber: '1', blockHash: ID })).toThrow(
      'malformed',
    );
    expect(DataApi.latestHeight({ blocks: [{ blockNumber: '42' }] })).toBe(42n);
    expect(() => DataApi.latestHeight({ blocks: [] })).toThrow('malformed');
  });
});

// A node's text is a claim: none makes `rejected`, which would end the Attempt.
describe('issueTx refusals', () => {
  it.each([
    ['attempted to issue duplicate tx: 2abc', { kind: 'already-known' }],
    ['insufficient funds', { kind: 'refused', code: 'FEE_TOO_LOW' }],
    [
      "couldn't issue tx: failed verification: insufficient unlocked funds: needs 5 more U8iR",
      { kind: 'refused', code: 'FEE_TOO_LOW' },
    ],
    ['failed to get utxo 2xyz: not found', { kind: 'refused', code: 'TX_REFUSED' }],
    [
      "couldn't issue tx: failed verification: failed to read consumed UTXO 2x:0 due to: not found",
      { kind: 'refused', code: 'TX_REFUSED' },
    ],
    ['tx conflicts with other tx: 2abc', { kind: 'refused', code: 'TX_REFUSED' }],
    ['mempool is full', { kind: 'refused', code: 'TX_REFUSED' }],
    [
      'tx too large: 2abc size (70000) > max size (65536)',
      { kind: 'refused', code: 'TX_REFUSED' },
    ],
    [
      'failed verification: output is time locked',
      { kind: 'refused', code: 'TX_REFUSED' },
    ],
    ['wrong signature', { kind: 'refused', code: 'TX_REFUSED' }],
    [
      'problem decoding transaction: invalid input checksum',
      { kind: 'refused', code: 'TX_REFUSED' },
    ],
  ])('%s', (message, expected) => {
    const result = classifyIssueError(message);
    expect(result).toMatchObject(expected);
    // Fixed texts, never the node's ids or amounts.
    if (result.kind === 'refused')
      expect(result.reason).not.toMatch(/2abc|2x|U8iR|65536/);
  });

  it('reads only the head of a long message', () => {
    expect(classifyIssueError(`${'x'.repeat(2_000)} duplicate tx`)).toMatchObject({
      kind: 'refused',
    });
  });
});

describe('the node client over the scripted node', () => {
  it('pages through an address with more outputs than one page', async () => {
    const h = avalancheHarness();
    h.node.mint(OTHER_BYTES, 1n);
    h.node.mint(OTHER_BYTES, 2n);
    const [first, second] = await h.run(
      h.ctx.node.utxos(h.address(OTHER_BYTES), { purpose: 'read' }),
    );
    const starts: unknown[] = [];
    // A full first page (1,024 entries, here one output listed alike), then a short one.
    h.node.intercept('main', (method, params) => {
      if (method !== 'avm.getUTXOs') return undefined;
      starts.push(params.startIndex);
      const utxos = params.startIndex
        ? [second as Uint8Array]
        : Array.from({ length: 1_024 }, () => first as Uint8Array);
      return {
        result: {
          numFetched: String(utxos.length),
          utxos: utxos.map(encodeChecked),
          endIndex: { address: 'X-fuji1end', utxo: 'last' },
        },
      };
    });
    const all = await h.run(
      h.ctx.node.utxos(h.address(OTHER_BYTES), { purpose: 'read' }),
    );
    expect(all).toEqual([first, second]);
    expect(starts).toEqual([undefined, { address: 'X-fuji1end', utxo: 'last' }]);
  });

  it('keeps an output listed twice alike once, and refuses one listed twice differently', async () => {
    const h = avalancheHarness();
    h.node.mint(OTHER_BYTES, 5n);
    const [bytes] = await h.run(
      h.ctx.node.utxos(h.address(OTHER_BYTES), { purpose: 'read' }),
    );
    const other = Uint8Array.from(bytes as Uint8Array);
    other[other.length - 1] = (other[other.length - 1] as number) ^ 1;
    const page = (utxos: readonly Uint8Array[]) => ({
      result: {
        numFetched: String(utxos.length),
        utxos: utxos.map(encodeChecked),
        endIndex: { address: 'x', utxo: 'y' },
      },
    });
    h.node.intercept('main', (method) =>
      method === 'avm.getUTXOs'
        ? page([bytes as Uint8Array, bytes as Uint8Array])
        : undefined,
    );
    const read = () =>
      h.run(h.ctx.node.utxos(h.address(OTHER_BYTES), { purpose: 'read' }));
    expect(await read()).toHaveLength(1);
    h.node.intercept('main', (method) =>
      method === 'avm.getUTXOs' ? page([bytes as Uint8Array, other]) : undefined,
    );
    await expect(read()).rejects.toThrow('an unspent output listed twice, differently');
  });

  it('refuses transaction bytes that do not hash to the id asked for', async () => {
    const h = avalancheHarness();
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.node.intercept('main', (method) =>
      method === 'avm.getTx'
        ? { result: { tx: encodeChecked(new Uint8Array(9)) } }
        : undefined,
    );
    await expect(h.run(h.ctx.node.txBytes(id, { purpose: 'read' }))).rejects.toThrow(
      'transaction bytes of another id',
    );
  });
});
