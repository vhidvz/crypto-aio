/**
 * A scripted EVM JSON-RPC node for offline tests. It is test-only: it decodes and
 * recovers raw transactions with ethers, so in `crypto-aio/testing` it would make the
 * testing kit depend on an optional peer. It keeps accounts, ERC-20 balances, a mempool
 * with geth's replacement rules, blocks with receipts and logs, a `finalized` head and
 * per-block state snapshots for reorgs. Its wire format follows the Ethereum JSON-RPC
 * spec: hex quantities, 0x-hex data.
 */
import {
  AbiCoder,
  Transaction,
  getAddress,
  getBytes,
  hexlify,
  id,
  keccak256,
} from 'ethers';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';

const hex = (value: bigint | number): string => `0x${value.toString(16)}`;
const abi = AbiCoder.defaultAbiCoder();

export const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
/** A contract whose every call and transfer reverts. */
export const REVERTER = '0x000000000000000000000000000000000000dEaD';
const SELECTOR = {
  transfer: id('transfer(address,uint256)').slice(0, 10),
  balanceOf: id('balanceOf(address)').slice(0, 10),
  decimals: id('decimals()').slice(0, 10),
  symbol: id('symbol()').slice(0, 10),
  getL1Fee: id('getL1Fee(bytes)').slice(0, 10),
};

export interface NodeOptions {
  readonly chainId: bigint;
  readonly clock: FakeClock;
  /** Blocks between the head and the `finalized` block (default 2). */
  readonly finalizedDepth?: number;
  readonly baseFee?: bigint;
  readonly gasPrice?: bigint;
  /** `eth_feeHistory` rewards per block at the 10th, 25th and 50th percentiles. */
  readonly rewards?: readonly [bigint, bigint, bigint];
  readonly minBumpPercent?: number;
  /** OP Stack: the L1 data fee `getL1Fee` returns and receipts carry. */
  readonly l1Fee?: bigint;
}

interface Token {
  readonly symbol: string;
  /** `undefined`: a junk token whose `decimals()` reverts. */
  readonly decimals?: number;
  /** A non-reverting token: a short `transfer` returns false, moves nothing, logs nothing. */
  readonly returnsFalse?: boolean;
  /** A broken token: a `transfer` pays (and logs a transfer to) this address instead. */
  readonly payTo?: string;
  /** A broken token: a `transfer` moves nothing and logs a zero-amount transfer. */
  readonly logsZero?: boolean;
  /** A fee-on-transfer token: keeps this percent for `FEE_SINK`, logging both transfers. */
  readonly feePercent?: bigint;
}

/** Where a fee-on-transfer token sends its fee. */
export const FEE_SINK = '0x000000000000000000000000000000000000fee5';

interface State {
  readonly balances: Map<string, bigint>;
  readonly nonces: Map<string, bigint>;
  readonly tokens: Map<string, Map<string, bigint>>;
}

interface NodeTx {
  readonly hash: string;
  readonly raw: string;
  readonly from: string;
  readonly to: string;
  readonly nonce: bigint;
  readonly value: bigint;
  readonly data: string;
  readonly type: number;
  readonly gasLimit: bigint;
  readonly maxFee: bigint;
  readonly tip: bigint;
  readonly json: Record<string, unknown>;
}

interface Log {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
}

interface Receipt {
  readonly tx: NodeTx;
  readonly status: 0 | 1;
  readonly gasUsed: bigint;
  readonly price: bigint;
  readonly logs: readonly Log[];
}

interface Block {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly txs: readonly string[];
}

export type Intercept = (
  endpoint: string,
  method: string,
  params: readonly unknown[],
) => { result: unknown } | { error: { code: number; message: string } } | undefined;

const lower = (address: string) => address.toLowerCase();

/** The yellow paper's M3:2048 bloom of `logs`: each address and topic sets three bits. */
function bloomOf(logs: readonly Log[]): string {
  const bloom = new Uint8Array(256);
  for (const value of logs.flatMap((log) => [log.address, ...log.topics])) {
    const hash = getBytes(keccak256(value));
    for (let i = 0; i < 6; i += 2) {
      const bit = (((hash[i] as number) << 8) | (hash[i + 1] as number)) & 2047;
      const byte = 255 - (bit >> 3);
      bloom[byte] = (bloom[byte] as number) | (1 << (bit & 7));
    }
  }
  return hexlify(bloom);
}

function credit(state: State, address: string, wei: bigint): void {
  const key = lower(address);
  state.balances.set(key, (state.balances.get(key) ?? 0n) + wei);
}

function mint(state: State, contract: string, to: string, amount: bigint): void {
  const book = state.tokens.get(lower(contract));
  if (!book) throw new Error('unknown token');
  book.set(lower(to), (book.get(lower(to)) ?? 0n) + amount);
}
const cloneState = (state: State): State => ({
  balances: new Map(state.balances),
  nonces: new Map(state.nonces),
  tokens: new Map([...state.tokens].map(([k, v]) => [k, new Map(v)])),
});

export class ScriptedEvmNode {
  readonly fetch = new FakeFetch();
  readonly options: Required<Omit<NodeOptions, 'l1Fee'>> & { readonly l1Fee?: bigint };
  /** JSON-RPC methods each endpoint served, in order. */
  readonly served: { endpoint: string; method: string }[] = [];
  intercept: Intercept | undefined;
  #finalizedDepth: number;
  /** The finalized height never moves backwards: a reorg or a deeper depth keeps it here. */
  #finalizedFloor = 0n;
  readonly #tokens = new Map<string, Token>();
  readonly #blocks: Block[] = [];
  readonly #states: State[] = [];
  #state: State = { balances: new Map(), nonces: new Map(), tokens: new Map() };
  readonly #mempool = new Map<string, NodeTx>();
  readonly #txs = new Map<string, NodeTx>();
  readonly #receipts = new Map<
    string,
    Receipt & { block: Block; index: number; logIndex: number }
  >();
  readonly #sends = new Map<string, number>();
  #fork = 0;

  constructor(options: NodeOptions) {
    this.options = {
      finalizedDepth: 2,
      baseFee: 1_000_000_000n,
      gasPrice: 5_000_000_000n,
      rewards: [1_000_000_000n, 2_000_000_000n, 3_000_000_000n],
      minBumpPercent: 10,
      ...options,
    };
    this.#finalizedDepth = this.options.finalizedDepth;
    this.#seal([]);
  }

  /** Blocks between the head and the `finalized` block; changing it never unfinalizes one. */
  get finalizedDepth(): number {
    return this.#finalizedDepth;
  }

  set finalizedDepth(depth: number) {
    this.#finalizedFloor = this.finalized;
    this.#finalizedDepth = depth;
  }

  /** Registers an endpoint URL served by this node. */
  endpoint(name: string): string {
    const url = `https://${name}.evm.test/rpc`;
    this.fetch.route(`https://${name}.evm.test`, (req) => this.#handle(name, req));
    return url;
  }

  get head(): bigint {
    return BigInt(this.#blocks.length - 1);
  }

  get finalized(): bigint {
    const height = this.head - BigInt(this.#finalizedDepth);
    return height > this.#finalizedFloor ? height : this.#finalizedFloor;
  }

  block(height: bigint): Block | undefined {
    return this.#blocks[Number(height)];
  }

  /** Test setup edits apply as if in genesis: to every block's state, so reorgs keep them. */
  fund(address: string, wei: bigint): void {
    for (const state of this.#all()) credit(state, address, wei);
  }

  deployToken(contract: string, token: Token): void {
    this.#tokens.set(lower(contract), token);
    for (const state of this.#all()) state.tokens.set(lower(contract), new Map());
  }

  mintToken(contract: string, to: string, amount: bigint): void {
    for (const state of this.#all()) mint(state, contract, to, amount);
  }

  #all(): State[] {
    return [this.#state, ...this.#states];
  }

  balance(address: string): bigint {
    return this.#state.balances.get(lower(address)) ?? 0n;
  }

  tokenBalance(contract: string, address: string): bigint {
    return this.#state.tokens.get(lower(contract))?.get(lower(address)) ?? 0n;
  }

  nonce(address: string): bigint {
    return this.#state.nonces.get(lower(address)) ?? 0n;
  }

  inMempool(hash: string): boolean {
    return this.#mempool.has(hash);
  }

  sendCount(hash: string): number {
    return this.#sends.get(hash) ?? 0;
  }

  receipt(
    hash: string,
  ): { status: 0 | 1; blockNumber: bigint; blockHash: string } | undefined {
    const r = this.#receipts.get(hash);
    return (
      r && { status: r.status, blockNumber: r.block.number, blockHash: r.block.hash }
    );
  }

  /**
   * What any endpoint answers to `method` with `params`, without recording it: lets an
   * `intercept` rewrite a call (e.g. serve `finalized` as another height) and answer it.
   */
  answer(method: string, params: readonly unknown[]): unknown {
    return this.#dispatch(method, [...params]);
  }

  /** Accepts a raw transaction as `eth_sendRawTransaction` would, from outside the library. */
  submit(raw: string): string {
    return this.#send(raw);
  }

  /** Mines `count` blocks, each including every executable mempool transaction. */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) this.#seal(this.#executable());
  }

  /**
   * Drops the last `depth` blocks and their state; their transactions return to the
   * mempool, except `drop`. The next `mine()` builds a fork with different block hashes.
   * Throws, changing nothing, when `depth` exceeds the head or would drop the finalized block
   * (deeper than `finalizedDepth`, or below the finalized height an earlier reorg kept).
   */
  reorg(depth: number, drop: readonly string[] = []): void {
    if (BigInt(depth) > this.head) {
      throw new Error(
        `reorg(${depth}) is deeper than the chain: the head is ${this.head}`,
      );
    }
    if (depth > this.#finalizedDepth || this.head - BigInt(depth) < this.finalized) {
      throw new Error(`reorg(${depth}) would drop the finalized block ${this.finalized}`);
    }
    this.#finalizedFloor = this.finalized;
    this.#fork += 1;
    const removed = this.#blocks.splice(this.#blocks.length - depth, depth);
    this.#states.splice(this.#states.length - depth, depth);
    this.#state = cloneState(this.#states[this.#states.length - 1] as State);
    for (const block of removed) {
      for (const hash of block.txs) {
        this.#receipts.delete(hash);
        const tx = this.#txs.get(hash) as NodeTx;
        if (!drop.includes(hash)) this.#mempool.set(hash, tx);
      }
    }
  }

  #executable(): NodeTx[] {
    const picked: NodeTx[] = [];
    const next = new Map<string, bigint>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const tx of this.#mempool.values()) {
        if (picked.includes(tx)) continue;
        const expected = next.get(tx.from) ?? this.nonce(tx.from);
        if (tx.nonce !== expected) continue;
        picked.push(tx);
        next.set(tx.from, expected + 1n);
        progress = true;
      }
    }
    return picked;
  }

  #seal(candidates: readonly NodeTx[]): void {
    const parent = this.#blocks[this.#blocks.length - 1];
    const number = BigInt(this.#blocks.length);
    const included: string[] = [];
    const executed: Receipt[] = [];
    // Once a sender's transaction cannot execute, its later nonces wait too: no nonce gap.
    const stalled = new Set<string>();
    for (const tx of candidates) {
      if (stalled.has(tx.from)) continue;
      const receipt = this.#execute(tx);
      if (!receipt) {
        stalled.add(tx.from);
        continue;
      }
      this.#mempool.delete(tx.hash);
      included.push(tx.hash);
      executed.push(receipt);
    }
    const parentHash = parent?.hash ?? `0x${'00'.repeat(32)}`;
    const block: Block = {
      number,
      hash: id(
        `${this.options.chainId}/${number}/${parentHash}/${this.#fork}/${included.join(',')}`,
      ),
      parentHash,
      timestamp: Math.floor(this.options.clock.now() / 1000),
      txs: included,
    };
    this.#blocks.push(block);
    let logIndex = 0;
    executed.forEach((receipt, index) => {
      this.#receipts.set(receipt.tx.hash, { ...receipt, block, index, logIndex });
      logIndex += receipt.logs.length;
    });
    this.#states.push(cloneState(this.#state));
  }

  #price(tx: NodeTx): bigint {
    if (tx.type !== 2) return tx.maxFee;
    const capped = this.options.baseFee + tx.tip;
    return capped < tx.maxFee ? capped : tx.maxFee;
  }

  /**
   * Applies `tx` to the state; `undefined` when its nonce is not the account's next one or it
   * cannot pay (it stays in the mempool).
   */
  #execute(tx: NodeTx): Receipt | undefined {
    if (tx.nonce !== this.nonce(tx.from)) return undefined;
    const price = this.#price(tx);
    const token = this.#tokens.get(lower(tx.to));
    const reverts = lower(tx.to) === lower(REVERTER);
    const needed = reverts ? 30_000n : token ? 51_000n : 21_000n;
    // Out of gas: the whole limit is used and paid for, and the transaction moves nothing.
    const outOfGas = needed > tx.gasLimit;
    const gasUsed = outOfGas ? tx.gasLimit : needed;
    const fee = gasUsed * price + (this.options.l1Fee ?? 0n);
    if (this.balance(tx.from) < fee + (reverts ? 0n : tx.value)) return undefined;
    credit(this.#state, tx.from, -fee);
    this.#state.nonces.set(lower(tx.from), tx.nonce + 1n);
    const base = { tx, gasUsed, price };
    if (reverts || outOfGas) return { ...base, status: 0, logs: [] };
    if (token && tx.data.startsWith(SELECTOR.transfer)) {
      const [to, amount] = abi.decode(
        ['address', 'uint256'],
        `0x${tx.data.slice(10)}`,
      ) as unknown as [string, bigint];
      if (this.tokenBalance(tx.to, tx.from) < amount)
        return { ...base, status: token.returnsFalse ? 1 : 0, logs: [] };
      const topic = (address: string) => abi.encode(['address'], [address]);
      const pay = (payee: string, value: bigint): Log => {
        mint(this.#state, tx.to, tx.from, -value);
        mint(this.#state, tx.to, payee, value);
        return {
          address: getAddress(tx.to),
          topics: [TRANSFER_TOPIC, topic(tx.from), topic(payee)],
          data: abi.encode(['uint256'], [value]),
        };
      };
      const fee = (amount * (token.feePercent ?? 0n)) / 100n;
      const logs = token.logsZero
        ? [pay(to, 0n)]
        : fee > 0n
          ? [pay(FEE_SINK, fee), pay(to, amount - fee)]
          : [pay(token.payTo ?? to, amount)];
      return { ...base, status: 1, logs };
    }
    credit(this.#state, tx.from, -tx.value);
    credit(this.#state, tx.to, tx.value);
    return { ...base, status: 1, logs: [] };
  }

  #stateAt(tag: unknown): State {
    if (tag === 'latest' || tag === 'pending' || tag === undefined) return this.#state;
    const height =
      tag === 'finalized' || tag === 'safe' ? this.finalized : BigInt(tag as string);
    const state = this.#states[Number(height)];
    if (!state) throw new RpcFailure(-32000, 'header not found');
    return state;
  }

  #blockAt(tag: unknown): Block | undefined {
    if (tag === 'latest' || tag === 'pending')
      return this.#blocks[this.#blocks.length - 1];
    if (tag === 'finalized' || tag === 'safe')
      return this.#blocks[Number(this.finalized)];
    if (tag === 'earliest') return this.#blocks[0];
    return this.#blocks[Number(BigInt(tag as string))];
  }

  #blockJson(block: Block, full: boolean): Record<string, unknown> {
    return {
      number: hex(block.number),
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: hex(block.timestamp),
      baseFeePerGas: hex(this.options.baseFee),
      miner: `0x${'00'.repeat(20)}`,
      gasLimit: hex(30_000_000),
      gasUsed: hex(0),
      extraData: '0x',
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      size: hex(1_000 + block.txs.length),
      logsBloom: bloomOf(
        block.txs.flatMap((hash) => this.#receipts.get(hash)?.logs ?? []),
      ),
      transactions: block.txs.map((hash) => (full ? this.#txJson(hash) : hash)),
    };
  }

  #txJson(hash: string): Record<string, unknown> | null {
    const tx = this.#txs.get(hash);
    if (!tx) return null;
    const receipt = this.#receipts.get(hash);
    if (!receipt && !this.#mempool.has(hash)) return null;
    return {
      ...tx.json,
      blockHash: receipt ? receipt.block.hash : null,
      blockNumber: receipt ? hex(receipt.block.number) : null,
      transactionIndex: receipt ? hex(receipt.index) : null,
      ...(receipt ? { gasPrice: hex(receipt.price) } : {}),
    };
  }

  #receiptJson(hash: string): Record<string, unknown> | null {
    const r = this.#receipts.get(hash);
    if (!r) return null;
    return {
      transactionHash: hash,
      transactionIndex: hex(r.index),
      blockHash: r.block.hash,
      blockNumber: hex(r.block.number),
      from: r.tx.from,
      to: r.tx.to,
      contractAddress: null,
      cumulativeGasUsed: hex(r.gasUsed),
      gasUsed: hex(r.gasUsed),
      effectiveGasPrice: hex(r.price),
      status: hex(r.status),
      type: hex(r.tx.type),
      logsBloom: bloomOf(r.logs),
      ...(this.options.l1Fee !== undefined ? { l1Fee: hex(this.options.l1Fee) } : {}),
      logs: this.#logsOf(r),
    };
  }

  #logsOf(r: Receipt & { block: Block; index: number; logIndex: number }) {
    return r.logs.map((log, i) => ({
      ...log,
      blockHash: r.block.hash,
      blockNumber: hex(r.block.number),
      transactionHash: r.tx.hash,
      transactionIndex: hex(r.index),
      logIndex: hex(r.logIndex + i),
      removed: false,
    }));
  }

  #send(raw: string): string {
    let tx: Transaction;
    try {
      tx = Transaction.from(raw);
    } catch {
      throw new RpcFailure(-32000, 'rlp: expected input list for types.LegacyTx');
    }
    if (tx.chainId !== this.options.chainId)
      throw new RpcFailure(-32000, 'invalid chain id for signer');
    if (!tx.from || !tx.hash || !tx.to) throw new RpcFailure(-32000, 'invalid sender');
    const from = lower(tx.from);
    const hash = tx.hash;
    this.#sends.set(hash, this.sendCount(hash) + 1);
    // geth answers "already known" only from its pool; a mined resend is "nonce too low".
    if (this.#mempool.has(hash)) throw new RpcFailure(-32000, 'already known');
    const nonce = BigInt(tx.nonce);
    if (nonce < this.nonce(from)) throw new RpcFailure(-32000, 'nonce too low');
    const legacy = tx.type !== 2;
    const maxFee = (legacy ? tx.gasPrice : tx.maxFeePerGas) as bigint;
    const tip = (legacy ? tx.gasPrice : tx.maxPriorityFeePerGas) as bigint;
    // These two answers are geth's execution-path texts, not its pool texts. They are kept
    // on purpose: the address-bearing "insufficient funds" text makes the tests that a
    // stored refusal reason names no address stricter.
    if (!legacy && maxFee < this.options.baseFee)
      throw new RpcFailure(-32000, 'max fee per gas less than block base fee');
    const cost = tx.value + tx.gasLimit * maxFee + (this.options.l1Fee ?? 0n);
    if (this.balance(from) < cost) {
      throw new RpcFailure(
        -32000,
        `insufficient funds for gas * price + value: address ${tx.from} have ${this.balance(from)} want ${cost}`,
      );
    }
    const bump = BigInt(100 + this.options.minBumpPercent);
    const threshold = (old: bigint) => (old * bump) / 100n;
    for (const other of this.#mempool.values()) {
      if (other.from !== from || other.nonce !== nonce) continue;
      // geth: each price strictly higher, and at least floor(old * (100 + bump) / 100).
      if (
        maxFee <= other.maxFee ||
        tip <= other.tip ||
        maxFee < threshold(other.maxFee) ||
        tip < threshold(other.tip)
      ) {
        throw new RpcFailure(-32000, 'replacement transaction underpriced');
      }
      this.#mempool.delete(other.hash);
    }
    const entry: NodeTx = {
      hash,
      raw,
      from,
      to: lower(tx.to),
      nonce,
      value: tx.value,
      data: tx.data,
      type: tx.type ?? 0,
      gasLimit: tx.gasLimit,
      maxFee,
      tip,
      json: {
        hash,
        from: tx.from,
        to: tx.to,
        nonce: hex(nonce),
        value: hex(tx.value),
        input: tx.data,
        type: hex(tx.type ?? 0),
        gas: hex(tx.gasLimit),
        chainId: hex(this.options.chainId),
        ...(legacy
          ? { gasPrice: hex(maxFee) }
          : {
              maxFeePerGas: hex(maxFee),
              maxPriorityFeePerGas: hex(tip),
              gasPrice: hex(maxFee),
            }),
        v: hex(tx.signature?.v ?? 0),
        r: tx.signature?.r,
        s: tx.signature?.s,
      },
    };
    this.#txs.set(hash, entry);
    this.#mempool.set(hash, entry);
    return hash;
  }

  #call(request: { to?: string; data?: string; from?: string }, tag: unknown): string {
    const to = lower(request.to ?? '');
    const data = request.data ?? '0x';
    if (to === lower(GAS_PRICE_ORACLE) && data.startsWith(SELECTOR.getL1Fee)) {
      if (this.options.l1Fee === undefined) return '0x';
      return abi.encode(['uint256'], [this.options.l1Fee]);
    }
    if (to === lower(REVERTER)) throw new RpcFailure(3, 'execution reverted');
    const token = this.#tokens.get(to);
    if (!token) return '0x';
    if (data.startsWith(SELECTOR.balanceOf)) {
      const [owner] = abi.decode(['address'], `0x${data.slice(10)}`) as unknown as [
        string,
      ];
      const book = this.#stateAt(tag).tokens.get(to);
      return abi.encode(['uint256'], [book?.get(lower(owner)) ?? 0n]);
    }
    if (data.startsWith(SELECTOR.decimals)) {
      if (token.decimals === undefined) throw new RpcFailure(3, 'execution reverted');
      return abi.encode(['uint8'], [token.decimals]);
    }
    if (data.startsWith(SELECTOR.symbol)) return abi.encode(['string'], [token.symbol]);
    throw new RpcFailure(3, 'execution reverted');
  }

  #estimate(request: {
    from?: string;
    to?: string;
    value?: string;
    data?: string;
  }): string {
    const to = lower(request.to ?? '');
    if (to === lower(REVERTER)) throw new RpcFailure(3, 'execution reverted');
    const token = this.#tokens.get(to);
    if (token && request.data?.startsWith(SELECTOR.transfer)) {
      const [, amount] = abi.decode(
        ['address', 'uint256'],
        `0x${request.data.slice(10)}`,
      ) as unknown as [string, bigint];
      if (this.tokenBalance(to, request.from ?? '') < amount && !token.returnsFalse)
        throw new RpcFailure(
          3,
          'execution reverted: ERC20: transfer amount exceeds balance',
        );
      return hex(51_000);
    }
    if (BigInt(request.value ?? '0x0') > this.balance(request.from ?? '')) {
      throw new RpcFailure(-32000, 'insufficient funds for transfer');
    }
    return hex(21_000);
  }

  #dispatch(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return hex(this.options.chainId);
      case 'eth_blockNumber':
        return hex(this.head);
      case 'eth_getBlockByNumber': {
        const block = this.#blockAt(params[0]);
        return block ? this.#blockJson(block, params[1] === true) : null;
      }
      case 'eth_getBlockByHash': {
        const block = this.#blocks.find((b) => b.hash === params[0]);
        return block ? this.#blockJson(block, params[1] === true) : null;
      }
      case 'eth_getBalance':
        return hex(
          this.#stateAt(params[1]).balances.get(lower(params[0] as string)) ?? 0n,
        );
      case 'eth_getTransactionCount': {
        const address = lower(params[0] as string);
        let nonce = this.#stateAt(params[1]).nonces.get(address) ?? 0n;
        if (params[1] === 'pending') {
          const queued = new Set(
            [...this.#mempool.values()]
              .filter((t) => t.from === address)
              .map((t) => t.nonce),
          );
          while (queued.has(nonce)) nonce += 1n;
        }
        return hex(nonce);
      }
      case 'eth_call':
        return this.#call(params[0] as { to?: string; data?: string }, params[1]);
      case 'eth_estimateGas':
        return this.#estimate(params[0] as { to?: string });
      case 'eth_gasPrice':
        return hex(this.options.gasPrice);
      case 'eth_feeHistory': {
        const count = Number(BigInt(params[0] as string));
        const oldest = this.head - BigInt(count) + 1n;
        return {
          oldestBlock: hex(oldest < 0n ? 0n : oldest),
          baseFeePerGas: Array.from({ length: count + 1 }, () =>
            hex(this.options.baseFee),
          ),
          gasUsedRatio: Array.from({ length: count }, () => 0.5),
          reward: Array.from({ length: count }, () => this.options.rewards.map(hex)),
        };
      }
      case 'eth_getTransactionByHash':
        return this.#txJson(params[0] as string);
      case 'eth_getTransactionReceipt':
        return this.#receiptJson(params[0] as string);
      case 'eth_getBlockReceipts': {
        // geth takes a block number, tag or hash; every receipt of the block, in order.
        const [at] = params;
        const block =
          typeof at === 'string' && at.length === 66
            ? this.#blocks.find((b) => b.hash === at)
            : this.#blockAt(at);
        return block ? block.txs.map((hash) => this.#receiptJson(hash)) : null;
      }
      case 'eth_getLogs': {
        const filter = params[0] as { blockHash: string; topics?: (string | null)[] };
        const block = this.#blocks.find((b) => b.hash === filter.blockHash);
        if (!block) throw new RpcFailure(-32000, 'unknown block');
        const topic0 = filter.topics?.[0];
        return block.txs
          .flatMap((hash) =>
            this.#logsOf(
              this.#receipts.get(hash) as Receipt & {
                block: Block;
                index: number;
                logIndex: number;
              },
            ),
          )
          .filter((log) => !topic0 || log.topics[0] === topic0);
      }
      case 'eth_sendRawTransaction':
        return this.#send(params[0] as string);
      default:
        throw new RpcFailure(
          -32601,
          `the method ${method} does not exist/is not available`,
        );
    }
  }

  #handle(endpoint: string, req: FakeRequest): FakeReply {
    const body = req.json<{ id: unknown; method: string; params?: unknown[] }>();
    this.served.push({ endpoint, method: body.method });
    const reply = (payload: object): FakeReply => ({
      json: { jsonrpc: '2.0', id: body.id, ...payload },
    });
    const scripted = this.intercept?.(endpoint, body.method, body.params ?? []);
    if (scripted) return reply(scripted);
    try {
      return reply({ result: this.#dispatch(body.method, body.params ?? []) });
    } catch (error) {
      if (error instanceof RpcFailure)
        return reply({ error: { code: error.code, message: error.message } });
      throw error;
    }
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
