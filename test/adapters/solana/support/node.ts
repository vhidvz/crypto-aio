/**
 * A scripted Solana JSON-RPC node for offline tests (test-only, Plan 5 D5). It models what
 * the driver's safety rests on (lesson 8): dense block heights over skipped slots, the
 * `confirmed` head and a `finalized` block `finalizedDepth` heights below it, blockhash
 * expiry after `blockhashValidity` blocks, the status cache ("already processed"), fees
 * (5,000 lamports per signature plus `ceil(price × limit / 1e6)`), compute-unit limits,
 * agave's rent-state rule (fee payer included), System transfers, SPL `transferChecked` and
 * associated token accounts in their programs' own check order, Memo, forks below the
 * head, lagging, gapped, pruned and load-balanced endpoints. Error texts are agave's, and a
 * preflight failure carries agave's simulation result as `data`, as the broadcast
 * classifier reads it. Wire numbers are exact u64 JSON.
 *
 * Each transaction runs on a copy of the state and commits only whole: a refused one
 * leaves no trace in blocks, balances or the mempool, across forks too. `intercept`
 * scripts faults per endpoint and method (a liar, `faults.rateLimited`, `unhealthy`,
 * `serverError`, `timeout`). Deterministic: time comes from the `FakeClock` only.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import { FakeFetch, hang, type FakeRequest } from '../../../../src/testing/fake-fetch';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const BUDGET = 'ComputeBudget111111111111111111111111111111';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** The node's own compute-unit model (not chain facts; each within real magnitudes). */
const COST = {
  budget: 150n,
  system: 150n,
  token: 105n,
  ataCreate: 20_000n,
  ataExists: 4_000n,
};
const memoCost = (bytes: number) => 12_000n + 25n * BigInt(bytes);
const U64_MAX = 2n ** 64n - 1n;

export interface NodeOptions {
  readonly clock: FakeClock;
  readonly genesisHash?: string;
  /** Heights between the head and the finalized block (default 2). */
  readonly finalizedDepth?: number;
  /** Blocks a blockhash stays valid after its own (default 150, agave's MAX_PROCESSING_AGE). */
  readonly blockhashValidity?: number;
  /** `getRecentPrioritizationFees` answers, micro-lamports (default all zero). */
  readonly prioritizationFees?: readonly number[];
}

export interface EndpointOptions {
  /** Blocks this endpoint lags behind the node's head. */
  readonly lag?: number;
  /** Blocks below this height were pruned from this endpoint's ledger. */
  readonly firstAvailableHeight?: number;
  /**
   * Heights this endpoint's ledger lacks (a jump to a snapshot, a long-term-storage gap):
   * `getBlock` answers -32009, `getBlocks` omits them, and their transactions are not found.
   */
  readonly missingHeights?: readonly bigint[];
  /**
   * The local ledger starts at this height and long-term storage fails every read below it
   * (agave 4.3.0): `getBlocks` from a slot below answers -32602 "BigTable query failed",
   * `getBlock` answers `null`, and transactions there are not found.
   */
  readonly bigtableFailsBelow?: bigint;
}

/** A URL behind a load balancer: each request is served by the next backend in turn. */
export interface BalancedOptions {
  readonly backends: readonly EndpointOptions[];
}

interface Account {
  readonly lamports: bigint;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

type State = Map<string, Account>;

interface Decoded {
  readonly signature: string;
  readonly raw: Uint8Array;
  readonly message: VersionedMessage;
  readonly keys: readonly string[];
  readonly signatures: readonly string[];
}

interface Inner {
  readonly index: number;
  readonly instructions: readonly Record<string, unknown>[];
}

interface Executed {
  readonly tx: Decoded;
  readonly err: unknown;
  /** The error's display text (agave's), when it failed. */
  readonly display?: string;
  readonly fee: bigint;
  readonly units: bigint;
  readonly pre: State;
  readonly post: State;
  readonly inner: readonly Inner[];
}

interface Block {
  readonly slot: bigint;
  readonly height: bigint;
  readonly hash: string;
  readonly parentSlot: bigint;
  readonly previousBlockhash: string;
  readonly blockTime: number;
  readonly txs: readonly Executed[];
  readonly state: State;
}

/**
 * What an `intercept` answers instead of the node: a JSON-RPC result or error, an HTTP-level
 * reply (a 429 with its Retry-After, a 5xx from a proxy), or no reply until the request is
 * aborted (a timeout).
 */
export type Scripted =
  | { readonly result: unknown }
  | {
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    }
  | {
      readonly http: {
        readonly status: number;
        readonly text?: string;
        readonly headers?: Readonly<Record<string, string>>;
      };
    }
  | { readonly hang: true };

export type Intercept = (
  endpoint: string,
  method: string,
  params: readonly unknown[],
) => Scripted | undefined;

/** Faults for an `intercept`, with agave's texts where agave sends them. */
export const faults = {
  /** HTTP 429 with a Retry-After (seconds); the transport answers `RATE_LIMITED`. */
  rateLimited: (retryAfterSeconds = 1): Scripted => ({
    http: { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  }),
  /** agave's `NodeUnhealthy` (-32005), which the transport treats as a rate limit. */
  unhealthy: (slotsBehind: number): Scripted => ({
    error: {
      code: -32005,
      message: `Node is behind by ${slotsBehind} slots`,
      data: { numSlotsBehind: slotsBehind },
    },
  }),
  /** A proxy's 5xx in front of the node (ambiguous: it may have reached the node). */
  serverError: (status = 503): Scripted => ({
    http: { status, text: 'Service Unavailable' },
  }),
  /** No answer until the caller aborts the request (its timeout). */
  timeout: { hang: true } as Scripted,
};

interface View {
  readonly head: Block;
  readonly finalized: Block;
  readonly firstAvailable: bigint;
  readonly missing: ReadonlySet<bigint>;
  readonly bigtableFailsBelow: bigint | undefined;
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** A transaction error: agave's `TransactionError` value and its display text. */
class TxError extends Error {
  constructor(
    readonly value: unknown,
    readonly display: string,
    /** Load errors (fee payer, blockhash) keep a transaction out of every block. */
    readonly load = false,
  ) {
    super(display);
  }
}

const ixError = (index: number, value: unknown, display: string) =>
  new TxError(
    { InstructionError: [index, value] },
    `Error processing Instruction ${index}: ${display}`,
  );
const custom = (index: number, code: number) =>
  ixError(index, { Custom: code }, `custom program error: 0x${code.toString(16)}`);

const u64le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
const u32le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);

function tokenAccountData(
  mint: string,
  owner: string,
  amount: bigint,
  frozen: boolean,
): Uint8Array {
  const data = new Uint8Array(165);
  data.set(base58.decode(mint), 0);
  data.set(base58.decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = frozen ? 2 : 1;
  return data;
}

function mintData(decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

interface TokenState {
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly frozen: boolean;
}

function readToken(account: Account | undefined): TokenState | null {
  if (!account || (account.owner !== TOKEN && account.owner !== TOKEN_2022)) return null;
  if (
    account.data.length !== 165 ||
    (account.data[108] !== 1 && account.data[108] !== 2)
  ) {
    return null;
  }
  return {
    mint: base58.encode(account.data.slice(0, 32)),
    owner: base58.encode(account.data.slice(32, 64)),
    amount: u64le(account.data, 64),
    frozen: account.data[108] === 2,
  };
}

/**
 * agave's simulation result (`RpcSimulateTransactionResult`), as `simulateTransaction`
 * answers it and as a preflight failure's `data` carries it: short enough for the
 * transport's 512-character `rpcData` cut, so the classifier reads its `err`.
 */
const simulation = (err: unknown, unitsConsumed: bigint) => ({
  accounts: null,
  err,
  innerInstructions: null,
  loadedAccountsDataSize: 0,
  logs: [],
  replacementBlockhash: null,
  returnData: null,
  unitsConsumed,
});

/** Exact u64 JSON: bigints are written as bare JSON numbers. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `__u64:${v.toString()}__` : v,
  ).replace(/"__u64:(\d+)__"/g, '$1');
}

export function associatedAddress(owner: string, mint: string, program = TOKEN): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(program).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ATA),
  )[0].toBase58();
}

export class ScriptedSolanaNode {
  readonly fetch = new FakeFetch();
  /** JSON-RPC methods each endpoint served, in order. */
  readonly served: { endpoint: string; method: string; params: readonly unknown[] }[] =
    [];
  /**
   * Answers a request instead of the node when it returns a reply (every request is still
   * recorded in `served`). An endpoint that answers its probes but fails requests is an
   * intercept on every other method; `answer` gives the node's own reply to alter.
   */
  intercept: Intercept | undefined;
  readonly genesisHash: string;
  readonly finalizedDepth: number;
  readonly validity: bigint;
  readonly #clock: FakeClock;
  readonly #fees: readonly number[];
  readonly #blocks: Block[] = [];
  readonly #bySlot = new Map<bigint, Block>();
  readonly #mempool = new Map<string, Decoded>();
  readonly #sends = new Map<string, number>();
  readonly #endpoints = new Map<string, readonly EndpointOptions[]>();
  readonly #turns = new Map<string, number>();
  #nextSlot = 1n;
  #fork = 0;
  #finalizedFloor = 0n;

  constructor(options: NodeOptions) {
    this.#clock = options.clock;
    this.genesisHash = options.genesisHash ?? DEVNET_GENESIS;
    this.finalizedDepth = options.finalizedDepth ?? 2;
    this.validity = BigInt(options.blockhashValidity ?? 150);
    this.#fees = options.prioritizationFees ?? [];
    const genesis: Block = {
      slot: 0n,
      height: 0n,
      hash: this.#hash(0n),
      parentSlot: 0n,
      previousBlockhash: this.#hash(0n),
      blockTime: Math.floor(this.#clock.now() / 1000),
      txs: [],
      state: new Map([
        [
          SYSTEM,
          {
            lamports: 1n,
            owner: 'NativeLoader1111111111111111111111111111111',
            data: new Uint8Array(),
            executable: true,
          },
        ],
        [
          TOKEN,
          {
            lamports: 1n,
            owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
            data: new Uint8Array(),
            executable: true,
          },
        ],
      ]),
    };
    this.#push(genesis);
  }

  /**
   * The endpoint URL for `name`: a lagging, pruned or gapped endpoint serves its own view,
   * and a load-balanced one (`{ backends }`) serves each request from the next backend.
   */
  endpoint(name: string, options: EndpointOptions | BalancedOptions = {}): string {
    const url = `https://${name}.solana.test/`;
    this.#endpoints.set(name, 'backends' in options ? options.backends : [options]);
    this.fetch.route(url, (request, signal) => this.#serve(name, request, signal));
    return url;
  }

  // ---- scripting -----------------------------------------------------------------------

  get head(): Block {
    return this.#blocks[this.#blocks.length - 1] as Block;
  }

  get finalized(): Block {
    const height = this.head.height - BigInt(this.finalizedDepth);
    const floor = height > this.#finalizedFloor ? height : this.#finalizedFloor;
    return this.#blocks[Number(floor < 0n ? 0n : floor)] as Block;
  }

  block(height: bigint): Block | undefined {
    return this.#blocks[Number(height)];
  }

  /** Produces `count` blocks, each including every valid pending transaction. */
  produce(count = 1): void {
    for (let i = 0; i < count; i++) this.#produce();
  }

  /** Skips `count` slots: no block is produced in them. */
  skip(count = 1): void {
    this.#nextSlot += BigInt(count);
  }

  /** Replaces the last `depth` blocks with a fork (never below finalized); their
   *  transactions return to the mempool unless listed in `drop`. */
  reorg(depth: number, drop: readonly string[] = []): void {
    if (this.head.height - BigInt(depth) < this.finalized.height) {
      throw new Error('cannot reorg below the finalized block');
    }
    this.#finalizedFloor = this.finalized.height;
    const removed = this.#blocks.splice(this.#blocks.length - depth, depth);
    for (const block of removed) {
      this.#bySlot.delete(block.slot);
      for (const executed of block.txs) {
        if (!drop.includes(executed.tx.signature)) {
          this.#mempool.set(executed.tx.signature, executed.tx);
        }
      }
    }
    this.#fork += 1;
  }

  /** Credits `lamports` to `address` in every block's state (as if since genesis). */
  fund(address: string, lamports: bigint): void {
    for (const { state } of this.#blocks) {
      const account = state.get(address);
      state.set(address, {
        lamports: (account?.lamports ?? 0n) + lamports,
        owner: account?.owner ?? SYSTEM,
        data: account?.data ?? new Uint8Array(),
        executable: account?.executable ?? false,
      });
    }
  }

  /** Sets an account in every block's state (as if since genesis). */
  setAccount(address: string, account: Partial<Account>): void {
    const value: Account = {
      lamports: account.lamports ?? 1_000_000n,
      owner: account.owner ?? SYSTEM,
      data: account.data ?? new Uint8Array(),
      executable: account.executable ?? false,
    };
    for (const { state } of this.#blocks) state.set(address, value);
  }

  createMint(mint: string, decimals: number, program = TOKEN): void {
    this.setAccount(mint, {
      owner: program,
      data: mintData(decimals),
      lamports: this.rent(82),
    });
  }

  /** Mints `amount` into `owner`'s associated token account (created when missing). */
  mintTo(
    mint: string,
    owner: string,
    amount: bigint,
    options: { frozen?: boolean } = {},
  ): string {
    const program = this.head.state.get(mint)?.owner ?? TOKEN;
    const address = associatedAddress(owner, mint, program);
    const current = readToken(this.head.state.get(address));
    this.setAccount(address, {
      owner: program,
      lamports: this.rent(165),
      data: tokenAccountData(
        mint,
        owner,
        (current?.amount ?? 0n) + amount,
        options.frozen ?? false,
      ),
    });
    return address;
  }

  balance(address: string): bigint {
    return this.head.state.get(address)?.lamports ?? 0n;
  }

  account(address: string): Account | undefined {
    return this.head.state.get(address);
  }

  tokenBalance(mint: string, owner: string): bigint {
    return readToken(this.head.state.get(associatedAddress(owner, mint)))?.amount ?? 0n;
  }

  rent(bytes: number): bigint {
    return (128n + BigInt(bytes)) * 5_080n;
  }

  inMempool(signature: string): boolean {
    return this.#mempool.has(signature);
  }

  drop(signature: string): void {
    this.#mempool.delete(signature);
  }

  sendCount(signature: string): number {
    return this.#sends.get(signature) ?? 0;
  }

  /** Where a transaction landed on the node's chain (head view). */
  landed(
    signature: string,
  ): { readonly block: Block; readonly err: unknown } | undefined {
    for (const block of this.#blocks) {
      const executed = block.txs.find((t) => t.tx.signature === signature);
      if (executed) return { block, err: executed.err };
    }
    return undefined;
  }

  /** The node's own answer to `method` at `endpoint`, as plain JSON (for intercept tests). */
  answer(endpoint: string, method: string, params: readonly unknown[]): unknown {
    const view = this.#view(this.#endpoints.get(endpoint)?.[0] ?? {});
    return JSON.parse(toJson(this.#method(view, method, params))) as unknown;
  }

  /** Submits base64 bytes as `sendTransaction` would, with preflight at `confirmed`. */
  submit(base64: string, options: { skipPreflight?: boolean } = {}): string {
    try {
      return this.#send(this.#view({}), [
        base64,
        { encoding: 'base64', preflightCommitment: 'confirmed', ...options },
      ]);
    } catch (error) {
      if (error instanceof RpcFailure) throw new Error(error.message);
      throw error;
    }
  }

  // ---- chain ---------------------------------------------------------------------------

  #hash(slot: bigint): string {
    return base58.encode(sha256(new TextEncoder().encode(`block:${this.#fork}:${slot}`)));
  }

  #push(block: Block): void {
    this.#blocks.push(block);
    this.#bySlot.set(block.slot, block);
  }

  #produce(): void {
    const parent = this.head;
    const slot = this.#nextSlot;
    this.#nextSlot += 1n;
    const height = parent.height + 1n;
    let state: State = new Map(parent.state);
    const txs: Executed[] = [];
    for (const [signature, tx] of this.#mempool) {
      this.#mempool.delete(signature);
      if (this.#processed(signature, parent)) continue;
      try {
        this.#blockhashValid(tx, parent, height);
        const executed = this.#execute(tx, state);
        txs.push(executed);
        state = executed.post;
      } catch (error) {
        if (!(error instanceof TxError)) throw error;
        // A load error (expired blockhash, unpayable fee) keeps it out of the block.
      }
    }
    this.#push({
      slot,
      height,
      hash: this.#hash(slot),
      parentSlot: parent.slot,
      previousBlockhash: parent.hash,
      blockTime: Math.floor(this.#clock.now() / 1000),
      txs,
      state,
    });
  }

  #processed(signature: string, bank: Block): boolean {
    for (let h = Number(bank.height); h >= 0; h--) {
      if (this.#blocks[h]?.txs.some((t) => t.tx.signature === signature)) return true;
    }
    return false;
  }

  /**
   * A blockhash is valid in the block at `height` while its age against that block's
   * PARENT is at most `validity` (agave registers a block's own hash only after its
   * transactions ran): so a transaction can land up to `lastValidBlockHeight + 1` (I1).
   */
  #blockhashValid(tx: Decoded, bank: Block, height: bigint): void {
    const hash = tx.message.recentBlockhash;
    const origin = this.#blocks.find((b) => b.hash === hash && b.height <= bank.height);
    if (!origin || height - 1n - origin.height > this.validity) {
      throw new TxError('BlockhashNotFound', 'Blockhash not found', true);
    }
  }

  #decode(raw: Uint8Array): Decoded {
    const tx = VersionedTransaction.deserialize(raw);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    return {
      signature: base58.encode(tx.signatures[0] as Uint8Array),
      raw,
      message: tx.message,
      keys,
      signatures: tx.signatures.map((s) => base58.encode(s)),
    };
  }

  #verify(tx: Decoded): boolean {
    const bytes = tx.message.serialize();
    const required = tx.message.header.numRequiredSignatures;
    if (tx.signatures.length !== required) return false;
    return tx.signatures.every((signature, i) => {
      try {
        return ed25519.verify(
          base58.decode(signature),
          bytes,
          base58.decode(tx.keys[i] as string),
          {
            zip215: false,
          },
        );
      } catch {
        return false;
      }
    });
  }

  /** Compute-unit limit and price from the message's ComputeBudget instructions. */
  #budget(message: VersionedMessage): { limit: bigint; price: bigint } {
    let limit: bigint | undefined;
    let price = 0n;
    let others = 0n;
    const keys = message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of message.compiledInstructions) {
      const data = ix.data;
      if (keys[ix.programIdIndex] !== BUDGET) {
        others += 1n;
        continue;
      }
      if (data[0] === 2 && data.length === 5) limit = BigInt(u32le(data, 1));
      if (data[0] === 3 && data.length === 9) price = u64le(data, 1);
    }
    const fallback = 200_000n * others;
    const chosen = limit ?? (fallback > 1_400_000n ? 1_400_000n : fallback);
    return { limit: chosen > 1_400_000n ? 1_400_000n : chosen, price };
  }

  /** The fee, saturating at u64::MAX as agave's fee arithmetic does. */
  #fee(message: VersionedMessage): bigint {
    const { limit, price } = this.#budget(message);
    const fee =
      5_000n * BigInt(message.header.numRequiredSignatures) +
      (price * limit + 999_999n) / 1_000_000n;
    return fee > U64_MAX ? U64_MAX : fee;
  }

  /** Runs a transaction on a copy of `state`: fee first, then its instructions atomically. */
  #execute(tx: Decoded, state: State): Executed {
    const message = tx.message;
    const payer = tx.keys[0] as string;
    const fee = this.#fee(message);
    const payerAccount = state.get(payer);
    if (!payerAccount) {
      throw new TxError(
        'AccountNotFound',
        'Attempt to debit an account but found no record of a prior credit.',
        true,
      );
    }
    if (payerAccount.owner !== SYSTEM || payerAccount.data.length > 0) {
      throw new TxError(
        'InvalidAccountForFee',
        'This account may not be used to pay transaction fees',
        true,
      );
    }
    if (payerAccount.lamports < fee) {
      throw new TxError('InsufficientFundsForFee', 'Insufficient funds for fee', true);
    }
    const left = payerAccount.lamports - fee;
    if (!this.#rentAllows(payerAccount, { ...payerAccount, lamports: left })) {
      throw new TxError(
        { InsufficientFundsForRent: { account_index: 0 } },
        'Transaction results in an account (0) with insufficient funds for rent',
        true,
      );
    }
    const pre = new Map(state);
    const charged = new Map(state);
    charged.set(payer, { ...payerAccount, lamports: left });
    const work = new Map(charged);
    const inner: Inner[] = [];
    const { limit } = this.#budget(message);
    let units = 0n;
    try {
      message.compiledInstructions.forEach((ix, index) => {
        units += this.#instruction(tx, ix, index, work, inner);
        if (units > limit) {
          throw ixError(
            index,
            'ComputationalBudgetExceeded',
            'Computational budget exceeded',
          );
        }
      });
      // agave compares against the accounts as loaded, the fee already charged.
      this.#rentCheck(tx, charged, work);
      ScriptedSolanaNode.#collect(work);
      return { tx, err: null, fee, units, pre, post: work, inner };
    } catch (error) {
      if (!(error instanceof TxError)) throw error;
      ScriptedSolanaNode.#collect(charged);
      return {
        tx,
        err: error.value,
        display: error.display,
        fee,
        units: units > limit ? limit : units,
        pre,
        post: charged,
        inner: [],
      };
    }
  }

  /** Accounts left with no lamports no longer exist. */
  static #collect(state: State): void {
    for (const [address, account] of state)
      if (account.lamports === 0n) state.delete(address);
  }

  /**
   * agave's rent-state transition rule: an account may end empty or rent-exempt; one that
   * was already rent-paying may stay so only with the same size and no more lamports.
   */
  #rentAllows(before: Account | undefined, after: Account | undefined): boolean {
    if (!after || after.lamports === 0n) return true;
    if (after.lamports >= this.rent(after.data.length)) return true;
    return (
      before !== undefined &&
      before.lamports > 0n &&
      before.lamports < this.rent(before.data.length) &&
      before.data.length === after.data.length &&
      after.lamports <= before.lamports
    );
  }

  #rentCheck(tx: Decoded, pre: State, post: State): void {
    tx.keys.forEach((key, index) => {
      if (!tx.message.isAccountWritable(index)) return;
      if (!this.#rentAllows(pre.get(key), post.get(key))) {
        throw new TxError(
          { InsufficientFundsForRent: { account_index: index } },
          `Transaction results in an account (${index}) with insufficient funds for rent`,
        );
      }
    });
  }

  #instruction(
    tx: Decoded,
    ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
    index: number,
    state: State,
    inner: Inner[],
  ): bigint {
    const program = tx.keys[ix.programIdIndex] as string;
    const account = (i: number) => tx.keys[ix.accountKeyIndexes[i] as number] as string;
    const signed = (i: number) =>
      tx.message.isAccountSigner(ix.accountKeyIndexes[i] as number);
    const data = ix.data;
    if (program === BUDGET) return COST.budget;
    if (program === SYSTEM) {
      if (data.length !== 12 || u32le(data, 0) !== 2) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const from = account(0);
      const to = account(1);
      const lamports = u64le(data, 4);
      if (!signed(0))
        throw ixError(
          index,
          'MissingRequiredSignature',
          'missing required signature for instruction',
        );
      const source = state.get(from);
      if (!source || source.owner !== SYSTEM || source.data.length > 0) {
        throw ixError(index, 'InvalidArgument', 'invalid program argument');
      }
      if (source.lamports < lamports) throw custom(index, 1);
      state.set(from, { ...source, lamports: source.lamports - lamports });
      const target = state.get(to);
      state.set(to, {
        lamports: (target?.lamports ?? 0n) + lamports,
        owner: target?.owner ?? SYSTEM,
        data: target?.data ?? new Uint8Array(),
        executable: target?.executable ?? false,
      });
      return COST.system;
    }
    if (program === ATA) {
      if (data.length !== 1 || data[0] !== 1) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const [payer, address, wallet, mint] = [
        account(0),
        account(1),
        account(2),
        account(3),
      ];
      if (address !== associatedAddress(wallet, mint)) {
        throw ixError(
          index,
          'InvalidSeeds',
          'Provided seeds do not result in a valid address',
        );
      }
      const current = state.get(address);
      const existing = current?.owner === TOKEN ? readToken(current) : null;
      if (existing) {
        // CreateIdempotent: a no-op on the wallet's own account for that mint.
        if (existing.owner !== wallet) throw custom(index, 0);
        if (existing.mint !== mint) {
          throw ixError(
            index,
            'InvalidAccountData',
            'invalid account data for instruction',
          );
        }
        return COST.ataExists;
      }
      if (current && current.owner !== SYSTEM) {
        throw ixError(index, 'IllegalOwner', 'Provided owner is not allowed');
      }
      // The token program's InitializeAccount3 checks the mint.
      const mintAccount = state.get(mint);
      if (mintAccount?.owner !== TOKEN) {
        throw ixError(
          index,
          'IncorrectProgramId',
          'incorrect program id for instruction',
        );
      }
      if (mintAccount.data.length !== 82 || mintAccount.data[45] !== 1) {
        throw custom(index, 2);
      }
      // Lamports already at the address stay; the payer adds what the minimum still lacks.
      const rent = this.rent(165);
      const held = current?.lamports ?? 0n;
      const needed = rent > held ? rent - held : 0n;
      const funder = state.get(payer);
      if (needed > 0n) {
        if (!funder || funder.lamports < needed) throw custom(index, 1);
        state.set(payer, { ...funder, lamports: funder.lamports - needed });
      }
      state.set(address, {
        lamports: held + needed,
        owner: TOKEN,
        data: tokenAccountData(mint, wallet, 0n, false),
        executable: false,
      });
      const system = (type: string, info: Record<string, unknown>) => ({
        parsed: { info, type },
        program: 'system',
        programId: SYSTEM,
        stackHeight: 2,
      });
      const create =
        held === 0n
          ? [
              system('createAccount', {
                lamports: rent,
                newAccount: address,
                owner: TOKEN,
                source: payer,
                space: 165,
              }),
            ]
          : [
              ...(needed > 0n
                ? [
                    system('transfer', {
                      destination: address,
                      lamports: needed,
                      source: payer,
                    }),
                  ]
                : []),
              system('allocate', { account: address, space: 165 }),
              system('assign', { account: address, owner: TOKEN }),
            ];
      inner.push({
        index,
        instructions: [
          ...create,
          {
            parsed: {
              info: { account: address, mint, owner: wallet },
              type: 'initializeAccount3',
            },
            program: 'spl-token',
            programId: TOKEN,
            stackHeight: 2,
          },
        ],
      });
      return COST.ataCreate;
    }
    if (program === TOKEN) {
      if (data.length !== 10 || data[0] !== 12) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const [source, mint, destination, authority] = [
        account(0),
        account(1),
        account(2),
        account(3),
      ];
      const amount = u64le(data, 1);
      const from = readToken(state.get(source));
      const to = readToken(state.get(destination));
      if (
        !from ||
        !to ||
        state.get(source)?.owner !== TOKEN ||
        state.get(destination)?.owner !== TOKEN
      ) {
        throw ixError(
          index,
          'InvalidAccountData',
          'invalid account data for instruction',
        );
      }
      // The token program's own order (`process_transfer`).
      if (from.frozen || to.frozen) throw custom(index, 17);
      if (from.amount < amount) throw custom(index, 1);
      if (from.mint !== to.mint || from.mint !== mint) throw custom(index, 3);
      const mintAccount = state.get(mint);
      if (!mintAccount || mintAccount.data.length !== 82 || mintAccount.data[45] !== 1) {
        throw ixError(
          index,
          'InvalidAccountData',
          'invalid account data for instruction',
        );
      }
      if (mintAccount.data[44] !== data[9]) throw custom(index, 18);
      if (from.owner !== authority) throw custom(index, 4);
      if (!signed(3))
        throw ixError(
          index,
          'MissingRequiredSignature',
          'missing required signature for instruction',
        );
      const put = (address: string, next: TokenState) =>
        state.set(address, {
          ...(state.get(address) as Account),
          data: tokenAccountData(next.mint, next.owner, next.amount, next.frozen),
        });
      put(source, { ...from, amount: from.amount - amount });
      const current = readToken(state.get(destination)) as TokenState;
      put(destination, { ...current, amount: current.amount + amount });
      return COST.token;
    }
    if (program === MEMO) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      return memoCost(data.length);
    }
    throw ixError(index, 'UnsupportedProgramId', 'Unsupported program id');
  }

  // ---- views ---------------------------------------------------------------------------

  /** The next backend's options for `endpoint` (load-balanced endpoints rotate). */
  #backend(endpoint: string): EndpointOptions {
    const backends = this.#endpoints.get(endpoint) ?? [{}];
    const turn = this.#turns.get(endpoint) ?? 0;
    this.#turns.set(endpoint, turn + 1);
    return backends[turn % backends.length] as EndpointOptions;
  }

  #view(options: EndpointOptions): View {
    const lag = BigInt(options.lag ?? 0);
    const headHeight = this.head.height - lag;
    const head = this.#blocks[Number(headHeight < 0n ? 0n : headHeight)] as Block;
    const target = head.height - BigInt(this.finalizedDepth);
    const floor = this.#finalizedFloor < head.height ? this.#finalizedFloor : head.height;
    const height = target > floor ? target : floor;
    return {
      head,
      finalized: this.#blocks[Number(height < 0n ? 0n : height)] as Block,
      firstAvailable: BigInt(options.firstAvailableHeight ?? 0),
      missing: new Set(options.missingHeights ?? []),
      bigtableFailsBelow: options.bigtableFailsBelow,
    };
  }

  /** Whether the view's ledger holds the block at `height`. */
  #holds(view: View, height: bigint): boolean {
    return (
      height >= view.firstAvailable &&
      !view.missing.has(height) &&
      (view.bigtableFailsBelow === undefined || height >= view.bigtableFailsBelow)
    );
  }

  #bank(view: View, commitment: unknown): Block {
    if (commitment === 'finalized' || commitment === undefined) return view.finalized;
    if (commitment === 'confirmed' || commitment === 'processed') return view.head;
    throw new RpcFailure(-32602, 'Invalid params: invalid commitment');
  }

  // ---- JSON-RPC ------------------------------------------------------------------------

  #serve(
    endpoint: string,
    request: FakeRequest,
    signal: AbortSignal | undefined,
  ): Response | Promise<Response> {
    const body = request.json<{ id: unknown; method: string; params?: unknown[] }>();
    const params = body.params ?? [];
    this.served.push({ endpoint, method: body.method, params });
    const reply = (payload: Record<string, unknown>) =>
      new Response(toJson({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const intercepted = this.intercept?.(endpoint, body.method, params);
    if (intercepted && 'hang' in intercepted) return hang(signal);
    if (intercepted && 'http' in intercepted) {
      const { status, text = '', headers = {} } = intercepted.http;
      return new Response(text, {
        status,
        headers: { 'content-type': 'text/plain', ...headers },
      });
    }
    if (intercepted) return reply(intercepted);
    try {
      const view = this.#view(this.#backend(endpoint));
      return reply({ result: this.#method(view, body.method, params) });
    } catch (error) {
      if (error instanceof RpcFailure) {
        return reply({
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        });
      }
      throw error;
    }
  }

  #method(view: View, method: string, params: readonly unknown[]): unknown {
    const config = (i: number) => (params[i] ?? {}) as Record<string, unknown>;
    const context = (bank: Block) => ({ apiVersion: '4.3.0', slot: bank.slot });
    switch (method) {
      case 'getGenesisHash':
        return this.genesisHash;
      case 'getSlot':
        return this.#bank(view, config(0).commitment).slot;
      case 'getBlockHeight':
        return this.#bank(view, config(0).commitment).height;
      case 'getLatestBlockhash': {
        const bank = this.#bank(view, config(0).commitment);
        return {
          context: context(bank),
          value: {
            blockhash: bank.hash,
            lastValidBlockHeight: bank.height + this.validity,
          },
        };
      }
      case 'getBalance': {
        const bank = this.#bank(view, config(1).commitment);
        return {
          context: context(bank),
          value: bank.state.get(params[0] as string)?.lamports ?? 0n,
        };
      }
      case 'getAccountInfo': {
        const bank = this.#bank(view, config(1).commitment);
        const account = bank.state.get(params[0] as string);
        return {
          context: context(bank),
          value: account ? this.#renderAccount(account) : null,
        };
      }
      case 'getTokenAccountsByOwner': {
        const bank = this.#bank(view, config(2).commitment);
        const owner = params[0] as string;
        const filter = config(1);
        const value = [...bank.state.entries()].flatMap(([address, account]) => {
          const token = readToken(account);
          if (!token || token.owner !== owner) return [];
          if (typeof filter.mint === 'string' && token.mint !== filter.mint) return [];
          if (typeof filter.programId === 'string' && account.owner !== filter.programId)
            return [];
          return [{ pubkey: address, account: this.#renderAccount(account) }];
        });
        return { context: context(bank), value };
      }
      case 'getMinimumBalanceForRentExemption':
        return this.rent(Number(params[0]));
      case 'getRecentPrioritizationFees':
        return this.#fees.map((fee, i) => ({
          prioritizationFee: fee,
          slot: view.head.slot - BigInt(i),
        }));
      case 'getFeeForMessage': {
        const bank = this.#bank(view, config(1).commitment);
        const message = VersionedMessage.deserialize(
          Buffer.from(params[0] as string, 'base64'),
        );
        const known = this.#blocks.some(
          (b) =>
            b.hash === message.recentBlockhash &&
            b.height <= bank.height &&
            bank.height - b.height <= this.validity,
        );
        return { context: context(bank), value: known ? this.#fee(message) : null };
      }
      case 'simulateTransaction':
        return this.#simulate(view, params);
      case 'sendTransaction':
        return this.#send(view, params);
      case 'getBlocks':
        return this.#getBlocks(view, params);
      case 'getBlock':
        return this.#getBlock(view, params);
      case 'getTransaction':
        return this.#getTransaction(view, params);
      case 'getSignaturesForAddress':
        return this.#getSignatures(view, params);
      default:
        throw new RpcFailure(-32601, 'Method not found');
    }
  }

  #renderAccount(account: Account) {
    return {
      data: [Buffer.from(account.data).toString('base64'), 'base64'],
      executable: account.executable,
      lamports: account.lamports,
      owner: account.owner,
      rentEpoch: 18446744073709551615n,
      space: account.data.length,
    };
  }

  #parseRaw(encoded: unknown): Decoded {
    try {
      return this.#decode(new Uint8Array(Buffer.from(encoded as string, 'base64')));
    } catch {
      throw new RpcFailure(
        -32602,
        'failed to deserialize solana_transaction::versioned::VersionedTransaction: io error: failed to fill whole buffer',
      );
    }
  }

  #simulate(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    const bank = this.#bank(view, options.commitment ?? 'finalized');
    const tx = this.#parseRaw(params[0]);
    try {
      if (options.sigVerify === true && !this.#verify(tx)) {
        throw new TxError(
          'SignatureFailure',
          'Transaction did not pass signature verification',
          true,
        );
      }
      if (options.replaceRecentBlockhash !== true)
        this.#blockhashValid(tx, bank, bank.height + 1n);
      const executed = this.#execute(tx, new Map(bank.state));
      return {
        context: { apiVersion: '4.3.0', slot: bank.slot },
        value: { ...simulation(executed.err, executed.units), fee: executed.fee },
      };
    } catch (error) {
      if (!(error instanceof TxError)) throw error;
      return {
        context: { apiVersion: '4.3.0', slot: bank.slot },
        value: simulation(error.value, 0n),
      };
    }
  }

  #send(view: View, params: readonly unknown[]): string {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.encoding !== 'base64')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    const tx = this.#parseRaw(params[0]);
    this.#sends.set(tx.signature, this.sendCount(tx.signature) + 1);
    if (options.skipPreflight === true) {
      // agave forwards unverified bytes; a leader drops a bad signature, so it never lands.
      if (!this.#verify(tx)) return tx.signature;
    } else {
      const bank = this.#bank(view, options.preflightCommitment ?? 'finalized');
      const fail = (error: TxError, units = 0n) =>
        new RpcFailure(
          -32002,
          `Transaction simulation failed: ${error.display}`,
          simulation(error.value, units),
        );
      if (!this.#verify(tx)) {
        throw fail(
          new TxError(
            'SignatureFailure',
            'Transaction did not pass signature verification',
          ),
        );
      }
      try {
        this.#blockhashValid(tx, bank, bank.height + 1n);
        if (this.#processed(tx.signature, bank)) {
          throw new TxError(
            'AlreadyProcessed',
            'This transaction has already been processed',
          );
        }
        const executed = this.#execute(tx, new Map(bank.state));
        if (executed.err !== null) {
          throw fail(
            new TxError(executed.err, executed.display ?? 'failed'),
            executed.units,
          );
        }
      } catch (error) {
        if (error instanceof TxError) throw fail(error);
        throw error;
      }
    }
    if (!this.#processed(tx.signature, this.head)) this.#mempool.set(tx.signature, tx);
    return tx.signature;
  }

  #getBlocks(view: View, params: readonly unknown[]): bigint[] {
    const start = BigInt(params[0] as number);
    const end = BigInt(params[1] as number);
    const bank = this.#bank(
      view,
      ((params[2] ?? {}) as Record<string, unknown>).commitment,
    );
    if (end - start > 500_000n)
      throw new RpcFailure(-32602, 'Slot range too large; max 500000');
    const minContextSlot = ((params[2] ?? {}) as Record<string, unknown>).minContextSlot;
    if (typeof minContextSlot === 'number' && BigInt(minContextSlot) > bank.slot) {
      throw new RpcFailure(-32016, 'Minimum context slot has not been reached', {
        contextSlot: bank.slot,
      });
    }
    const local = view.bigtableFailsBelow;
    if (local !== undefined && start < (this.#blocks[Number(local)]?.slot ?? 0n)) {
      throw new RpcFailure(
        -32602,
        'BigTable query failed (maybe timeout due to too large range?)',
      );
    }
    return this.#blocks
      .filter(
        (b) =>
          b.slot >= start &&
          b.slot <= end &&
          b.slot <= bank.slot &&
          this.#holds(view, b.height),
      )
      .map((b) => b.slot);
  }

  #blockAt(view: View, slot: bigint, bank: Block): Block {
    if (slot > bank.slot)
      throw new RpcFailure(-32004, `Block not available for slot ${slot}`);
    const block = this.#bySlot.get(slot);
    if (!block || block.height > bank.height) {
      throw new RpcFailure(
        -32007,
        `Slot ${slot} was skipped, or missing due to ledger jump to recent snapshot`,
      );
    }
    if (block.height < view.firstAvailable) {
      // agave names the first available block by its slot.
      const first =
        this.#blocks[Number(view.firstAvailable)]?.slot ?? view.firstAvailable;
      throw new RpcFailure(
        -32001,
        `Block ${slot} cleaned up, does not exist on node. First available block: ${first}`,
      );
    }
    if (view.missing.has(block.height)) {
      throw new RpcFailure(
        -32009,
        `Slot ${slot} was skipped, or missing in long-term storage`,
      );
    }
    return block;
  }

  #getBlock(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.commitment === 'processed') {
      throw new RpcFailure(
        -32602,
        'Method does not support commitment below `confirmed`',
      );
    }
    const bank = this.#bank(view, options.commitment);
    const block = this.#blockAt(view, BigInt(params[0] as number), bank);
    // A failed long-term-storage read is not "block not found": agave answers `null`.
    if (view.bigtableFailsBelow !== undefined && block.height < view.bigtableFailsBelow) {
      return null;
    }
    const header = {
      blockHeight: block.height,
      blockTime: block.blockTime,
      blockhash: block.hash,
      parentSlot: block.parentSlot,
      previousBlockhash: block.previousBlockhash,
    };
    if (options.transactionDetails === 'none') return header;
    if (options.transactionDetails === 'signatures') {
      return { ...header, signatures: block.txs.map((t) => t.tx.signature) };
    }
    if (options.encoding !== 'jsonParsed')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    return { ...header, transactions: block.txs.map((t) => this.#renderTx(t)) };
  }

  #find(
    signature: string,
    bank: Block,
  ): { block: Block; executed: Executed } | undefined {
    for (let h = Number(bank.height); h >= 0; h--) {
      const block = this.#blocks[h] as Block;
      const executed = block.txs.find((t) => t.tx.signature === signature);
      if (executed) return { block, executed };
    }
    return undefined;
  }

  #getTransaction(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.encoding !== 'jsonParsed')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    const bank = this.#bank(view, options.commitment);
    const found = this.#find(params[0] as string, bank);
    if (!found || !this.#holds(view, found.block.height)) return null;
    return {
      slot: found.block.slot,
      blockTime: found.block.blockTime,
      ...this.#renderTx(found.executed),
    };
  }

  #getSignatures(view: View, params: readonly unknown[]) {
    const address = params[0] as string;
    const options = (params[1] ?? {}) as Record<string, unknown>;
    const limit = Number(options.limit ?? 1000);
    if (limit < 1 || limit > 1000)
      throw new RpcFailure(-32602, 'Invalid limit; max 1000');
    const bank = this.#bank(view, options.commitment);
    const all: { block: Block; executed: Executed }[] = [];
    for (let h = Number(bank.height); h >= Number(view.firstAvailable); h--) {
      const block = this.#blocks[h] as Block;
      if (!this.#holds(view, block.height)) continue;
      for (const executed of [...block.txs].reverse()) {
        if (executed.tx.keys.includes(address)) all.push({ block, executed });
      }
    }
    let start = 0;
    if (typeof options.before === 'string') {
      const at = all.findIndex((e) => e.executed.tx.signature === options.before);
      if (at < 0) throw new RpcFailure(-32020, `Transaction ${options.before} not found`);
      start = at + 1;
    }
    return all.slice(start, start + limit).map(({ block, executed }) => ({
      blockTime: block.blockTime,
      confirmationStatus:
        block.height <= view.finalized.height ? 'finalized' : 'confirmed',
      err: executed.err,
      memo: null,
      signature: executed.tx.signature,
      slot: block.slot,
    }));
  }

  // ---- jsonParsed rendering ------------------------------------------------------------

  #tokenBalances(tx: Decoded, state: State) {
    return tx.keys.flatMap((key, accountIndex) => {
      const account = state.get(key);
      const token = readToken(account);
      if (!token || !account) return [];
      const decimals = state.get(token.mint)?.data[44] ?? 0;
      const amount = token.amount.toString();
      return [
        {
          accountIndex,
          mint: token.mint,
          owner: token.owner,
          programId: account.owner,
          uiTokenAmount: {
            amount,
            decimals,
            uiAmount: Number(token.amount) / 10 ** decimals,
            uiAmountString: String(Number(token.amount) / 10 ** decimals),
          },
        },
      ];
    });
  }

  #renderInstruction(
    tx: Decoded,
    ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
  ): Record<string, unknown> {
    const programId = tx.keys[ix.programIdIndex] as string;
    const account = (i: number) => tx.keys[ix.accountKeyIndexes[i] as number] as string;
    const data = ix.data;
    if (programId === SYSTEM && data.length === 12 && u32le(data, 0) === 2) {
      return {
        parsed: {
          info: { destination: account(1), lamports: u64le(data, 4), source: account(0) },
          type: 'transfer',
        },
        program: 'system',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === ATA && data[0] === 1) {
      return {
        parsed: {
          info: {
            account: account(1),
            mint: account(3),
            source: account(0),
            systemProgram: account(4),
            tokenProgram: account(5),
            wallet: account(2),
          },
          type: 'createIdempotent',
        },
        program: 'spl-associated-token-account',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === TOKEN && data[0] === 12 && data.length === 10) {
      const amount = u64le(data, 1);
      const decimals = data[9] as number;
      return {
        parsed: {
          info: {
            authority: account(3),
            destination: account(2),
            mint: account(1),
            source: account(0),
            tokenAmount: {
              amount: amount.toString(),
              decimals,
              uiAmount: Number(amount) / 10 ** decimals,
              uiAmountString: String(Number(amount) / 10 ** decimals),
            },
          },
          type: 'transferChecked',
        },
        program: 'spl-token',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === MEMO) {
      return {
        parsed: new TextDecoder().decode(data),
        program: 'spl-memo',
        programId,
        stackHeight: 1,
      };
    }
    return {
      accounts: ix.accountKeyIndexes.map((i) => tx.keys[i]),
      data: base58.encode(data),
      programId,
      stackHeight: 1,
    };
  }

  #renderTx(executed: Executed) {
    const { tx } = executed;
    const message = tx.message;
    return {
      meta: {
        computeUnitsConsumed: executed.units,
        err: executed.err,
        fee: executed.fee,
        innerInstructions: executed.inner,
        logMessages: [],
        postBalances: tx.keys.map((k) => executed.post.get(k)?.lamports ?? 0n),
        postTokenBalances: this.#tokenBalances(tx, executed.post),
        preBalances: tx.keys.map((k) => executed.pre.get(k)?.lamports ?? 0n),
        preTokenBalances: this.#tokenBalances(tx, executed.pre),
        rewards: [],
        status: executed.err === null ? { Ok: null } : { Err: executed.err },
      },
      transaction: {
        message: {
          accountKeys: tx.keys.map((pubkey, i) => ({
            pubkey,
            signer: message.isAccountSigner(i),
            source: 'transaction',
            writable: message.isAccountWritable(i),
          })),
          instructions: message.compiledInstructions.map((ix) =>
            this.#renderInstruction(tx, ix),
          ),
          recentBlockhash: message.recentBlockhash,
        },
        signatures: tx.signatures,
      },
      version: 'legacy',
    };
  }
}
