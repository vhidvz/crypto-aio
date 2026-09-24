import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1Ecdsa } from '../core/registry/schemes';
import { fromHex, toHex, utf8ToBytes } from '../core/util/bytes';
import { systemClock, type Clock } from '../core/util/clock';
import { canonicalJson, sha256Hex } from '../core/util/json';

export type FakeOrdering = 'nonce' | 'seqno' | 'expiry';

/** Unsigned fake transaction; numbers travel as decimal strings. */
export interface FakeUnsigned {
  readonly chainId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly fee: string;
  readonly nonce?: string;
  readonly lastValidHeight?: string;
  readonly memo?: string;
}

export interface FakeEnvelope {
  readonly tx: FakeUnsigned;
  readonly sig: string;
  readonly recovery: number;
  readonly pub: string;
}

export interface FakeWireTx {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly fee: string;
  readonly nonce?: string;
  readonly memo?: string;
  readonly blockHeight?: string;
  readonly blockHash?: string;
  readonly success?: boolean;
  readonly pending?: boolean;
}

export interface FakeWireBlock {
  readonly height: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly txIds: readonly string[];
  readonly txs?: readonly FakeWireTx[];
}

export interface FakeEndpointOptions {
  lag?: number;
  identity?: string;
  seesMempool?: boolean;
  down?: boolean;
  html?: boolean;
  acceptThenFail?: boolean;
  refuseNext?: string;
  forkFinalized?: boolean;
}

export interface FakeChainOptions {
  readonly ordering?: FakeOrdering;
  readonly chainId?: string;
  readonly finalityDepth?: number;
  readonly minFee?: bigint;
  readonly replacementBumpPercent?: number;
  readonly clock?: Clock;
}

export const REVERT_ADDRESS = `fk1${'dead'.repeat(10)}`;
const HOST = 'fake-chain.test';

export function fakeAddress(publicKey: Uint8Array): string {
  return `fk1${sha256Hex(publicKey).slice(0, 40)}`;
}

export function isFakeAddress(value: string): boolean {
  return /^fk1[0-9a-f]{40}$/i.test(value);
}

export function fakeDigest(tx: FakeUnsigned): Uint8Array {
  return sha256(utf8ToBytes(canonicalJson(tx)));
}

export function encodeEnvelope(envelope: FakeEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

export function decodeEnvelope(raw: string): FakeEnvelope | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64').toString('utf8'),
    ) as FakeEnvelope | null;
    return value && typeof value === 'object' && value.tx && typeof value.tx === 'object'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function fakeTxId(raw: string): string {
  return sha256Hex(raw);
}

/** Signs outside the library (for tests that craft conflicting transactions). */
export function signFake(tx: FakeUnsigned, privateKey: Uint8Array): string {
  const signature = secp256k1.sign(fakeDigest(tx), privateKey, { lowS: true });
  return encodeEnvelope({
    tx,
    sig: toHex(signature.toCompactRawBytes()),
    recovery: signature.recovery,
    pub: toHex(secp256k1.getPublicKey(privateKey, true)),
  });
}

interface ChainTx {
  readonly id: string;
  readonly tx: FakeUnsigned;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly nonce?: bigint;
  readonly lastValidHeight?: bigint;
}

interface FakeBlock {
  readonly height: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly txs: readonly ChainTx[];
}

export interface FakeReceipt {
  readonly success: boolean;
  readonly height: bigint;
  readonly hash: string;
}

interface ChainState {
  readonly balances: Map<string, bigint>;
  readonly nonces: Map<string, bigint>;
  readonly receipts: Map<string, FakeReceipt>;
}

class RpcFailure extends Error {}

export class FakeChain {
  readonly ordering: FakeOrdering;
  readonly chainId: string;
  readonly finalityDepth: number;
  readonly minFee: bigint;
  readonly bumpPercent: bigint;
  readonly #clock: Clock;
  readonly #blocks: FakeBlock[] = [];
  readonly #mempool = new Map<string, ChainTx>();
  readonly #funding = new Map<string, bigint>();
  readonly #endpoints = new Map<string, FakeEndpointOptions>();
  readonly #sends = new Map<string, number>();
  #salt = 0;

  constructor(options: FakeChainOptions = {}) {
    this.ordering = options.ordering ?? 'nonce';
    this.chainId = options.chainId ?? 'fake-local';
    this.finalityDepth = options.finalityDepth ?? 3;
    this.minFee = options.minFee ?? 1n;
    this.bumpPercent = BigInt(options.replacementBumpPercent ?? 10);
    this.#clock = options.clock ?? systemClock;
    this.#blocks.push({
      height: 0n,
      hash: sha256Hex(`genesis:${this.chainId}`),
      parentHash: '0'.repeat(64),
      timestamp: this.#clock.now(),
      txs: [],
    });
  }

  get head(): bigint {
    return this.#tip().height;
  }

  finalizedHeight(): bigint {
    const height = this.head - BigInt(this.finalityDepth);
    return height > 0n ? height : 0n;
  }

  block(
    height: bigint,
  ): { height: bigint; hash: string; parentHash: string; txIds: string[] } | undefined {
    const block = this.#blocks[Number(height)];
    return (
      block && {
        height: block.height,
        hash: block.hash,
        parentHash: block.parentHash,
        txIds: block.txs.map((t) => t.id),
      }
    );
  }

  fund(address: string, amount: bigint): void {
    const key = address.toLowerCase();
    this.#funding.set(key, (this.#funding.get(key) ?? 0n) + amount);
  }

  balance(address: string, height: bigint = this.head): bigint {
    return this.#state(height).balances.get(address.toLowerCase()) ?? 0n;
  }

  nonce(address: string, height: bigint = this.head): bigint {
    return this.#state(height).nonces.get(address.toLowerCase()) ?? 0n;
  }

  receipt(id: string, height: bigint = this.head): FakeReceipt | undefined {
    return this.#state(height).receipts.get(id);
  }

  inMempool(id: string): boolean {
    return this.#mempool.has(id);
  }

  sendCount(id: string): number {
    return this.#sends.get(id) ?? 0;
  }

  dropFromMempool(id: string): void {
    this.#mempool.delete(id);
  }

  /** Admits a raw transaction directly (bypassing endpoints). Throws the node's error message. */
  submit(raw: string): string {
    return this.#admit(raw);
  }

  mine(count = 1): void {
    for (let i = 0; i < count; i++) {
      const parent = this.#tip();
      const height = parent.height + 1n;
      const { balances, nonces } = this.#state(parent.height);
      const included: ChainTx[] = [];
      const candidates = [...this.#mempool.values()];
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const tx of candidates) {
          if (included.includes(tx)) continue;
          if (this.ordering === 'expiry') {
            if ((tx.lastValidHeight ?? -1n) < height) continue;
          } else if (tx.nonce !== (nonces.get(tx.from) ?? 0n)) {
            continue;
          }
          if ((balances.get(tx.from) ?? 0n) < tx.amount + tx.fee) continue;
          this.#apply(tx, balances, nonces);
          included.push(tx);
          progressed = true;
        }
      }
      const hash = sha256Hex(
        `${height}:${parent.hash}:${included.map((t) => t.id).join(',')}:${this.#salt}`,
      );
      this.#blocks.push({
        height,
        hash,
        parentHash: parent.hash,
        timestamp: this.#clock.now(),
        txs: included,
      });
      for (const tx of included) this.#mempool.delete(tx.id);
      for (const tx of [...this.#mempool.values()]) {
        const stale =
          this.ordering === 'expiry'
            ? (tx.lastValidHeight ?? -1n) <= height
            : (tx.nonce ?? -1n) < (nonces.get(tx.from) ?? 0n);
        if (stale) this.#mempool.delete(tx.id);
      }
    }
  }

  /** Replaces the last `depth` blocks with `depth + 1` new ones; dropped txs do not return. */
  reorg(
    depth: number,
    options: { readonly drop?: readonly string[]; readonly force?: boolean } = {},
  ): void {
    if (depth < 1) throw new Error('reorg depth must be >= 1');
    const keep = this.head - BigInt(depth);
    if (keep < 0n) throw new Error('cannot reorg past genesis');
    if (keep < this.finalizedHeight() && !options.force) {
      throw new Error('cannot reorg below the finalized height');
    }
    const removed = this.#blocks.splice(Number(keep) + 1);
    this.#salt += 1;
    for (const block of removed) {
      for (const tx of block.txs)
        if (!options.drop?.includes(tx.id)) this.#mempool.set(tx.id, tx);
    }
    this.mine(depth + 1);
  }

  endpoint(name: string, options: FakeEndpointOptions = {}): string {
    this.#endpoints.set(name, { lag: 0, seesMempool: true, ...options });
    return `https://${HOST}/${name}`;
  }

  configureEndpoint(name: string, patch: FakeEndpointOptions): void {
    const current = this.#endpoints.get(name);
    if (!current) throw new Error(`unknown endpoint ${name}`);
    Object.assign(current, patch);
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const name = url.pathname.split('/').filter(Boolean)[0] ?? '';
    const endpoint = this.#endpoints.get(name);
    if (url.host !== HOST || !endpoint) {
      throw new TypeError('fetch failed', {
        cause: new Error(`getaddrinfo ENOTFOUND ${url.host}`),
      });
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    if (endpoint.down) return new Response('service unavailable', { status: 503 });
    if (endpoint.html) return new Response('<html>maintenance</html>', { status: 200 });
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as {
      id?: unknown;
      method?: string;
      params?: unknown[];
    } | null;
    const reply = (payload: object) =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, ...payload }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    try {
      const result = this.#handle(endpoint, request?.method ?? '', request?.params ?? []);
      if (request?.method === 'fake_sendRawTransaction' && endpoint.acceptThenFail) {
        endpoint.acceptThenFail = false;
        return new Response('gateway timeout', { status: 504 });
      }
      return reply({ result });
    } catch (error) {
      if (error instanceof RpcFailure)
        return reply({ error: { code: -32000, message: error.message } });
      throw error;
    }
  }) as typeof fetch;

  #tip(): FakeBlock {
    return this.#blocks[this.#blocks.length - 1] as FakeBlock;
  }

  #apply(
    tx: ChainTx,
    balances: Map<string, bigint>,
    nonces: Map<string, bigint>,
  ): boolean {
    const success = tx.to !== REVERT_ADDRESS;
    balances.set(
      tx.from,
      (balances.get(tx.from) ?? 0n) - tx.fee - (success ? tx.amount : 0n),
    );
    if (success) balances.set(tx.to, (balances.get(tx.to) ?? 0n) + tx.amount);
    if (this.ordering !== 'expiry') nonces.set(tx.from, (nonces.get(tx.from) ?? 0n) + 1n);
    return success;
  }

  #state(height: bigint): ChainState {
    const balances = new Map(this.#funding);
    const nonces = new Map<string, bigint>();
    const receipts = new Map<string, FakeReceipt>();
    for (const block of this.#blocks) {
      if (block.height > height) break;
      for (const tx of block.txs) {
        receipts.set(tx.id, {
          success: this.#apply(tx, balances, nonces),
          height: block.height,
          hash: block.hash,
        });
      }
    }
    return { balances, nonces, receipts };
  }

  #admit(raw: string): string {
    const envelope = decodeEnvelope(raw);
    if (!envelope) throw new RpcFailure('malformed transaction');
    const { tx } = envelope;
    if (tx.chainId !== this.chainId) throw new RpcFailure('invalid chain id');
    let publicKey: Uint8Array;
    let signature: Uint8Array;
    try {
      publicKey = fromHex(envelope.pub);
      signature = fromHex(envelope.sig);
    } catch {
      throw new RpcFailure('malformed transaction');
    }
    if (fakeAddress(publicKey) !== tx.from) throw new RpcFailure('invalid sender');
    if (
      !secp256k1Ecdsa.verify({
        publicKey,
        payload: fakeDigest(tx),
        signature,
        recovery: envelope.recovery,
      })
    ) {
      throw new RpcFailure('invalid signature');
    }
    const id = fakeTxId(raw);
    const state = this.#state(this.head);
    if (state.receipts.has(id)) {
      throw new RpcFailure(
        this.ordering === 'expiry' ? 'already processed' : 'nonce too low',
      );
    }
    if (this.#mempool.has(id)) throw new RpcFailure('already known');
    const entry: ChainTx = {
      id,
      tx,
      from: tx.from,
      to: tx.to.toLowerCase(),
      amount: BigInt(tx.amount),
      fee: BigInt(tx.fee),
      ...(tx.nonce !== undefined ? { nonce: BigInt(tx.nonce) } : {}),
      ...(tx.lastValidHeight !== undefined
        ? { lastValidHeight: BigInt(tx.lastValidHeight) }
        : {}),
    };
    if (entry.fee < this.minFee) throw new RpcFailure('fee too low');
    if (this.ordering === 'expiry') {
      if (entry.lastValidHeight === undefined || entry.lastValidHeight <= this.head) {
        throw new RpcFailure('transaction expired');
      }
    } else {
      const expected = state.nonces.get(entry.from) ?? 0n;
      if (entry.nonce === undefined || entry.nonce < expected)
        throw new RpcFailure('nonce too low');
      const sameSlot = [...this.#mempool.values()].find(
        (t) => t.from === entry.from && t.nonce === entry.nonce,
      );
      if (this.ordering === 'seqno') {
        if (entry.nonce !== expected || sameSlot) throw new RpcFailure('seqno mismatch');
      } else if (sameSlot) {
        if (entry.fee * 100n < sameSlot.fee * (100n + this.bumpPercent)) {
          throw new RpcFailure('replacement transaction underpriced');
        }
        this.#mempool.delete(sameSlot.id);
      }
    }
    if ((state.balances.get(entry.from) ?? 0n) < entry.amount + entry.fee) {
      throw new RpcFailure('insufficient funds');
    }
    this.#mempool.set(id, entry);
    return id;
  }

  #findMined(id: string): { tx: ChainTx; block: FakeBlock } | undefined {
    for (const block of this.#blocks)
      for (const tx of block.txs) if (tx.id === id) return { tx, block };
    return undefined;
  }

  #wire(tx: ChainTx, block?: FakeBlock): FakeWireTx {
    return {
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount.toString(),
      fee: tx.fee.toString(),
      ...(tx.nonce !== undefined ? { nonce: tx.nonce.toString() } : {}),
      ...(tx.tx.memo !== undefined ? { memo: tx.tx.memo } : {}),
      ...(block
        ? {
            blockHeight: block.height.toString(),
            blockHash: block.hash,
            success: tx.to !== REVERT_ADDRESS,
          }
        : { pending: true }),
    };
  }

  #wireTx(id: string, height: bigint, includeMempool: boolean): FakeWireTx | null {
    const mined = this.#findMined(id);
    if (mined && mined.block.height <= height) return this.#wire(mined.tx, mined.block);
    const pending = includeMempool ? this.#mempool.get(id) : undefined;
    return pending ? this.#wire(pending) : null;
  }

  #wireBlock(block: FakeBlock, full: boolean): FakeWireBlock {
    return {
      height: block.height.toString(),
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      txIds: block.txs.map((t) => t.id),
      ...(full ? { txs: block.txs.map((t) => this.#wire(t, block)) } : {}),
    };
  }

  #handle(
    endpoint: FakeEndpointOptions,
    method: string,
    params: readonly unknown[],
  ): unknown {
    const lagged = this.head - BigInt(endpoint.lag ?? 0);
    const view = lagged > 0n ? lagged : 0n;
    const finalizedRaw = view - BigInt(this.finalityDepth);
    const finalized = finalizedRaw > 0n ? finalizedRaw : 0n;
    const arg = (index: number): string => String(params[index] ?? '');
    switch (method) {
      case 'fake_identity':
        return endpoint.identity ?? this.chainId;
      case 'fake_blockNumber':
        return view.toString();
      case 'fake_feeRate':
        return this.minFee.toString();
      case 'fake_finalizedBlock': {
        const block = this.#blocks[Number(finalized)] as FakeBlock;
        return {
          height: finalized.toString(),
          hash: endpoint.forkFinalized ? 'f'.repeat(64) : block.hash,
          timestamp: block.timestamp,
        };
      }
      case 'fake_getBlock': {
        const ref = arg(0);
        const block = /^[0-9a-f]{64}$/.test(ref)
          ? this.#blocks.find((b) => b.hash === ref)
          : this.#blocks[
              Number(
                ref === 'latest' ? view : ref === 'finalized' ? finalized : BigInt(ref),
              )
            ];
        if (!block || block.height > view) return null;
        return this.#wireBlock(block, params[1] === true);
      }
      case 'fake_getBalance': {
        const height = arg(1) === 'finalized' ? finalized : view;
        return (this.#state(height).balances.get(arg(0).toLowerCase()) ?? 0n).toString();
      }
      case 'fake_getNonce': {
        const address = arg(0).toLowerCase();
        const level = arg(1);
        let next =
          this.#state(level === 'finalized' ? finalized : view).nonces.get(address) ?? 0n;
        if (level === 'pending' && endpoint.seesMempool !== false) {
          const queued = new Set(
            [...this.#mempool.values()]
              .filter((t) => t.from === address)
              .map((t) => t.nonce),
          );
          while (queued.has(next)) next += 1n;
        }
        return next.toString();
      }
      case 'fake_sendRawTransaction': {
        const raw = arg(0);
        const id = fakeTxId(raw);
        this.#sends.set(id, (this.#sends.get(id) ?? 0) + 1);
        if (endpoint.refuseNext) {
          const message = endpoint.refuseNext;
          endpoint.refuseNext = undefined;
          throw new RpcFailure(message);
        }
        return this.#admit(raw);
      }
      case 'fake_getTransaction':
        return this.#wireTx(arg(0), view, endpoint.seesMempool !== false);
      case 'fake_getFinalizedTransaction':
        return endpoint.forkFinalized ? null : this.#wireTx(arg(0), finalized, false);
      default:
        throw new RpcFailure(`method not found: ${method}`);
    }
  }
}
