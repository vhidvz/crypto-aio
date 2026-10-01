/**
 * A scripted toncenter node for offline tests: API v2 (a liteserver proxy) and API v3 (an
 * indexer) over one simulated chain. It is test-only, since it parses messages with
 * `@ton/core` and `crypto-aio/testing` must not depend on an optional peer. It exists to
 * test safety invariants, so it models the rules the driver relies on exactly, never more
 * leniently than the chain, each from the contract or node source:
 * - wallets v4r2 and v5r1: signature over the signing cell hash (front / tail), wallet id,
 *   seqno, `valid_until <= now` refusal, deployment by `StateInit`, seqno committed before
 *   the actions; a v5r1 `internal_signed` request relayed in an internal message, ignored
 *   when its signature fails (wallet_v5.fc); a frozen wallet refuses everything;
 * - each message's send mode (transaction.cpp): +1 pays the forward fee on top of the value
 *   (else the fee comes out of it), +2 skips a message the balance cannot pay; without +2
 *   the action phase fails (37, `no_funds`), rolling back the seqno and every message
 *   while the gas stays charged and nothing bounces; other flags are refused (34);
 * - fee emulation as tonlib's `estimate_fees` runs it: on the endpoint's view, gas bought
 *   with the balance, the wallet's own checks before its accept, a forward fee only for a
 *   run that succeeded;
 * - external messages the chain cannot accept are refused at send time (HTTP 500, with the
 *   liteserver's own texts), checked against the endpoint's own view, and, when state
 *   changed meanwhile, silently never included; one whose balance pays the accept but not
 *   the run is included out of gas (-14);
 * - internal messages delivered one masterchain block later, bounce for bounceable
 *   messages whose compute phase failed or was skipped (`nofunds`, the value kept, when it
 *   is below the bounce's cost), TEP-74 jettons with the 707 sender check,
 *   notifications, excesses and bounced `internal_transfer`s;
 * - one masterchain block per `mine()`, one or two basechain shards (`shards`, real shard
 *   ids), each `shardLagSeconds` (the second `secondShardLagSeconds`) older than its
 *   masterchain block; an account's transactions run at its own shard's time;
 * - state snapshots per masterchain block for `seqno=` reads;
 * - an indexer that trails the chain by `indexerLag` blocks, and traces, named after their
 *   root transaction, that complete only when every message of the trace has been
 *   delivered and indexed;
 * - each API's own error envelope (v2 `{ ok: false, error, code }`, v3 `{ error }`), with
 *   HTTP 422 for a parameter it cannot parse.
 * Deterministic: time comes from the `FakeClock`, hashes from SHA-256 of counters.
 */
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import {
  Address,
  Cell,
  Dictionary,
  beginCell,
  loadMessage,
  loadMessageRelaxed,
  loadOutList,
  storeMessage,
  storeMessageRelaxed,
  storeStateInit,
  storeTransaction,
  type AccountStatus,
  type DictionaryValue,
  type Message,
  type MessageRelaxed,
  type TransactionComputePhase,
  type TransactionDescriptionGeneric,
} from '@ton/core';
import {
  WalletContractV4,
  WalletContractV5R1,
  computeMessageForwardFees,
  configParseMsgPrices,
} from '@ton/ton';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';

/**
 * Basechain shard ids (signed 64-bit, as toncenter v2 writes them): the whole basechain, or
 * its two halves after one split (address prefix bit 0: 0x4000…, bit 1: 0xC000…).
 */
const SHARD_SETS: Readonly<Record<1 | 2, readonly string[]>> = {
  1: ['-9223372036854775808'],
  2: ['4611686018427387904', '-4611686018427387904'],
};

/** Config param 25 (basechain message prices), as read live from mainnet. */
export const MSG_PRICES_BOC =
  'te6cckEBAQEAIwAAQuoAAAAAAAEEawAAAAAAQqqrAAAAABoKqqsAAYAAVVVVVXUQ/H0=';
/** Config param 24 (masterchain message prices), as on mainnet. */
export const MC_MSG_PRICES_BOC =
  'te6cckEBAQEAIwAAQuoAAAAAAJiWgAAAAAAnEAAAAAAAD0JAAAAAAYAAVVVVVX2jQy8=';
const pricesOf = (boc: string) =>
  configParseMsgPrices(
    (Cell.fromBoc(Buffer.from(boc, 'base64'))[0] as Cell).beginParse(),
  );
/** Message prices: the masterchain's when the source or the destination is on it. */
const PRICES = {
  basechain: pricesOf(MSG_PRICES_BOC),
  masterchain: pricesOf(MC_MSG_PRICES_BOC),
};

/** Fixed fees of the simulated chain, nanograms. */
export const NODE_FEES = Object.freeze({
  importFee: 1_000_000n,
  gasV4: 2_000_000n,
  gasV5: 2_500_000n,
  deployGas: 500_000n,
  internalGas: 300_000n,
  jettonGas: 10_000_000n,
  /** The gas fee toncenter's `estimateFee` reports when no code runs (live, mainnet). */
  flatGas: 6_667n,
  /**
   * Config params 21 and 20 (mainnet's values): `flat_gas_price`, what the first
   * `flat_gas_limit` (100) gas units of any run cost, on the basechain and the masterchain.
   */
  flatGasPrice: 40_000n,
  mcFlatGasPrice: 1_000_000n,
});

/** A config param 20/21 cell: `gas_flat_pfx#d1` over `gas_prices_ext#de` (block.tlb). */
export function gasPricesBoc(flatGasPrice: bigint, gasPrice: bigint): string {
  return beginCell()
    .storeUint(0xd1, 8)
    .storeUint(100, 64)
    .storeUint(flatGasPrice, 64)
    .storeUint(0xde, 8)
    .storeUint(gasPrice * 65_536n, 64)
    .storeUint(1_000_000, 64)
    .storeUint(1_000_000, 64)
    .storeUint(10_000, 64)
    .storeUint(10_000_000, 64)
    .storeUint(100_000_000, 64)
    .storeUint(1_000_000_000, 64)
    .endCell()
    .toBoc()
    .toString('base64');
}

/**
 * VM steps are not metered: a refusal the wallet code raises reports the step count of a
 * live v4r2 expiry refusal (13).
 */
const VM_STEPS = 13;

const WALLET_CODE = {
  v4r2: WalletContractV4.create({ workchain: 0, publicKey: Buffer.alloc(32) }).init.code,
  v5r1: WalletContractV5R1.create({ publicKey: Buffer.alloc(32) }).init.code,
};
const OP = {
  transfer: 0x0f8a7ea5,
  internalTransfer: 0x178d4519,
  notification: 0x7362d09c,
  excesses: 0xd53276db,
  signed: 0x7369676e,
  signedInternal: 0x73696e74,
};

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const upper = (raw: string): string => raw.toUpperCase();
const rawOf = (address: Address): string =>
  `${address.workChain}:${address.hash.toString('hex')}`;

type Wallet = {
  readonly version: 'v4r2' | 'v5r1';
  readonly publicKey: Buffer;
  readonly walletId: number;
  seqno: number;
};
type Jetton = {
  readonly symbol?: string;
  readonly decimals?: number;
  readonly content: 'onchain' | 'offchain';
};
type JettonWallet = { readonly master: string; readonly owner: string; balance: bigint };

interface Account {
  balance: bigint;
  status: 'active' | 'uninitialized' | 'frozen';
  wallet?: Wallet;
  jetton?: Jetton;
  jettonWallet?: JettonWallet;
  /** A contract that throws on every inbound internal message. */
  reverter?: boolean;
  /** It holds an extra currency: a +128+32 destroy leaves it uninitialized. */
  extraCurrency?: boolean;
  lastLt: bigint;
  lastHash: string;
}

interface Msg {
  readonly hash: string;
  readonly source: string | null;
  readonly destination: string;
  readonly value: bigint | null;
  readonly bounce: boolean;
  readonly bounced: boolean;
  readonly body: Cell;
  readonly hashNorm?: string;
  /** The `StateInit` the message carries, used or not. */
  readonly initState?: Cell;
  /** The message as the chain holds it: its cell goes into the raw transaction. */
  readonly message: Message;
}

/** toncenter v3's account statuses. */
type V3Status = 'nonexist' | 'uninit' | 'active' | 'frozen';

interface Tx {
  readonly hash: string;
  readonly lt: bigint;
  readonly account: string;
  readonly now: number;
  readonly mcSeqno: number;
  readonly traceId: string;
  readonly totalFees: bigint;
  readonly origStatus: V3Status;
  readonly endStatus: V3Status;
  readonly description: Record<string, unknown>;
  readonly inMsg: Msg;
  readonly outMsgs: readonly Msg[];
  /** The transaction cell (block.tlb `transaction$0111`): `hash` is its hash. */
  readonly raw: Cell;
  /** The account's previous transaction (0 and zeros at the start of a chain). */
  readonly prevLt: bigint;
  readonly prevHash: string;
}

interface Queued {
  readonly msg: Msg;
  readonly traceId: string;
  readonly readyAt: number;
  /** The delivery is its trace's root (an injected message): its hash is `traceId`. */
  readonly root?: boolean;
}

interface Block {
  readonly seqno: number;
  readonly genUtime: number;
  readonly rootHash: string;
  readonly fileHash: string;
  /** The shard top blocks this masterchain block commits. */
  readonly shards: readonly {
    readonly shard: string;
    readonly seqno: number;
    readonly genUtime: number;
    readonly rootHash: string;
    readonly fileHash: string;
  }[];
  readonly state: Map<string, Account>;
}

export interface TonNodeOptions {
  readonly clock: FakeClock;
  /** Config param 19 (default -3, testnet). */
  readonly globalId?: number;
  /** Masterchain blocks the indexer trails the chain by (default 0). */
  readonly indexerLag?: number;
  /** How much older than its masterchain block each shard block is, in seconds. */
  readonly shardLagSeconds?: number;
  /** Basechain shards (default 1); a second shard is `secondShardLagSeconds` older. */
  readonly shards?: 1 | 2;
  readonly secondShardLagSeconds?: number;
}

/** Replaces the node's answer when it returns one; a promise scripts a late or lost one. */
export type Intercept = (
  endpoint: string,
  route: string,
  request: FakeRequest,
  signal: AbortSignal | undefined,
) => FakeReply | Promise<FakeReply> | undefined;

/** A request parameter the API cannot parse: HTTP 422, as toncenter answers it. */
class ParamError extends Error {}

/** A wallet request's message with its send mode. */
interface Requested {
  readonly mode: number;
  readonly message: MessageRelaxed;
}

/** The outcome of a wallet's action phase. */
type Actions =
  | {
      readonly ok: true;
      readonly out: readonly Msg[];
      readonly forwardFees: bigint;
      readonly skipped: number;
      /** +128+32 carried the whole balance and asked to delete the account. */
      readonly destroy?: boolean;
    }
  | { readonly ok: false; readonly resultCode: number; readonly skipped: number };

const cloneAccount = (a: Account): Account => ({
  ...a,
  ...(a.wallet ? { wallet: { ...a.wallet } } : {}),
  ...(a.jettonWallet ? { jettonWallet: { ...a.jettonWallet } } : {}),
});

export class ScriptedTonNode {
  readonly fetch = new FakeFetch();
  readonly served: { readonly endpoint: string; readonly route: string }[] = [];
  intercept?: Intercept;
  indexerLag: number;
  shardLagSeconds: number;
  secondShardLagSeconds: number;
  readonly shardCount: 1 | 2;
  /** Accepts external messages, then loses them: they are never included. */
  swallow = false;
  readonly globalId: number;
  readonly #clock: FakeClock;
  readonly #accounts = new Map<string, Account>();
  readonly #blocks: Block[] = [];
  readonly #txs: Tx[] = [];
  readonly #pending: {
    readonly boc: string;
    readonly cell: Cell;
    readonly hash: string;
  }[] = [];
  readonly #queue: Queued[] = [];
  readonly #sends = new Map<string, number>();
  readonly #lag = new Map<string, number>();
  #lt = 1_000_000n;
  #counter = 0;

  constructor(options: TonNodeOptions) {
    this.#clock = options.clock;
    this.globalId = options.globalId ?? -3;
    this.indexerLag = options.indexerLag ?? 0;
    this.shardLagSeconds = options.shardLagSeconds ?? 0;
    this.secondShardLagSeconds = options.secondShardLagSeconds ?? 0;
    this.shardCount = options.shards ?? 1;
    this.#seal();
  }

  /** The v2 (`rpc`) or v3 (`indexer`) base URL of a named endpoint (routed once). */
  endpoint(name: string, api: 'v2' | 'v3'): string {
    const base = `https://${name}.ton.test/api/${api}`;
    if (!this.#routed.has(base)) {
      this.#routed.add(base);
      this.fetch.route(base, (request, signal) =>
        this.#serve(name, api, request, signal),
      );
    }
    return base;
  }

  readonly #routed = new Set<string>();

  /** A v2 endpoint that serves the chain `blocks` masterchain blocks behind the head. */
  lagEndpoint(name: string, blocks: number): void {
    this.#lag.set(name, blocks);
  }

  get head(): number {
    return (this.#blocks.at(-1) as Block).seqno;
  }

  /** The newest indexed masterchain block; never below the first one (seqno 1). */
  get indexed(): number {
    return Math.max(1, this.head - this.indexerLag);
  }

  block(seqno: number): Block | undefined {
    return this.#blocks.find((b) => b.seqno === seqno);
  }

  // ---- scripting ------------------------------------------------------------------------
  // Every helper keys accounts by the canonical raw address, however a test spells it.

  fund(address: string, nanograms: bigint): void {
    this.#account(normalizeParam(address)).balance += nanograms;
    this.#sealState();
  }

  /** An already deployed wallet at `address` (tests of an active wallet's seqno). */
  deployWallet(
    address: string,
    wallet: {
      version: 'v4r2' | 'v5r1';
      publicKey: Uint8Array;
      walletId: number;
      seqno?: number;
    },
  ): void {
    const account = this.#account(normalizeParam(address));
    account.status = 'active';
    account.wallet = {
      version: wallet.version,
      publicKey: Buffer.from(wallet.publicKey),
      walletId: wallet.walletId,
      seqno: wallet.seqno ?? 0,
    };
    this.#sealState();
  }

  /** Takes nanograms from an account, as another spend of the same wallet would. */
  debit(address: string, nanograms: bigint): void {
    this.#account(normalizeParam(address)).balance -= nanograms;
    this.#sealState();
  }

  /**
   * Freezes an account (storage debt), as the chain does to an account it cannot charge.
   * A frozen wallet refuses every message, its deploy `StateInit` included.
   */
  freeze(address: string): void {
    this.#account(normalizeParam(address)).status = 'frozen';
    this.#sealState();
  }

  /**
   * The account holds an extra currency: a +128+32 destroy leaves it uninitialized in the
   * same chain rather than deleted (transaction.cpp).
   */
  holdExtraCurrency(address: string): void {
    this.#account(normalizeParam(address)).extraCurrency = true;
    this.#sealState();
  }

  /** A contract that fails every inbound message (bounceable ones bounce). */
  deployReverter(address: string): void {
    const account = this.#account(normalizeParam(address));
    account.status = 'active';
    account.reverter = true;
    this.#sealState();
  }

  deployJetton(master: string, jetton: Jetton): void {
    const account = this.#account(normalizeParam(master));
    account.status = 'active';
    account.jetton = jetton;
    this.#sealState();
  }

  /** The jetton wallet the master assigns to `owner`. */
  jettonWalletOf(master: string, owner: string): string {
    const identity = { master: normalizeParam(master), owner: normalizeParam(owner) };
    const address = jettonWalletAddress(identity.master, identity.owner);
    this.#jettonWallets.set(address, identity);
    return address;
  }

  /** Each standard jetton wallet's master and owner: what its `StateInit` encodes. */
  readonly #jettonWallets = new Map<
    string,
    { readonly master: string; readonly owner: string }
  >();

  /** A contract at `address` that claims to be `owner`'s jetton wallet of `master`. */
  deployFakeJettonWallet(
    address: string,
    master: string,
    owner: string,
    balance: bigint,
  ): void {
    const account = this.#account(normalizeParam(address));
    account.status = 'active';
    account.jettonWallet = {
      master: normalizeParam(master),
      owner: normalizeParam(owner),
      balance,
    };
    this.#sealState();
  }

  mintJetton(master: string, owner: string, amount: bigint): void {
    const address = this.jettonWalletOf(master, owner);
    const account = this.#account(address);
    account.status = 'active';
    account.jettonWallet = account.jettonWallet ?? {
      ...(this.#jettonWallets.get(address) as { master: string; owner: string }),
      balance: 0n,
    };
    account.jettonWallet.balance += amount;
    this.#sealState();
  }

  jettonBalance(master: string, owner: string): bigint {
    return (
      this.#accounts.get(this.jettonWalletOf(master, owner))?.jettonWallet?.balance ?? 0n
    );
  }

  balance(address: string): bigint {
    return this.#accounts.get(normalizeParam(address))?.balance ?? 0n;
  }

  status(address: string): Account['status'] {
    return this.#accounts.get(normalizeParam(address))?.status ?? 'uninitialized';
  }

  seqno(address: string): number {
    return this.#accounts.get(normalizeParam(address))?.wallet?.seqno ?? 0;
  }

  /** How many times the message with this normalized hash was sent. */
  sendCount(hashNorm: string): number {
    return this.#sends.get(hashNorm) ?? 0;
  }

  pendingCount(): number {
    return this.#pending.length;
  }

  /** Drops the pending messages: what a node restart without the message looks like. */
  dropPending(): void {
    this.#pending.length = 0;
  }

  transactions(): readonly Tx[] {
    return this.#txs;
  }

  /**
   * Queues an internal message from any account, delivered with the next block. Its
   * delivery is the root of its trace.
   */
  inject(
    source: string,
    destination: string,
    value: bigint,
    body: Cell,
    bounce = false,
  ): void {
    this.#queue.push({
      msg: this.#internal(
        normalizeParam(source),
        normalizeParam(destination),
        value,
        bounce,
        body,
      ),
      traceId: this.#hashOf('tx'),
      readyAt: this.head + 1,
      root: true,
    });
  }

  /** Accepts an external message as `/sendBocReturnHash` does; throws the node's text. */
  submit(boc: string): { readonly hash: string; readonly hashNorm: string } {
    return this.#submit(boc, this.#accounts);
  }

  /** Produces `count` masterchain blocks (each with one block per shard). */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) this.#mineOne();
  }

  // ---- chain rules ----------------------------------------------------------------------

  /** Checks an external message against `view` (an endpoint's state), then queues it. */
  #submit(
    boc: string,
    view: ReadonlyMap<string, Account>,
  ): { readonly hash: string; readonly hashNorm: string } {
    const cell = Cell.fromBoc(Buffer.from(boc, 'base64'))[0] as Cell;
    const message = loadMessage(cell.beginParse());
    if (message.info.type !== 'external-in') throw new Error('Failed to unpack Message');
    const dest = rawOf(message.info.dest);
    const hashNorm = normalizedHash(cell);
    const verdict = this.#checkExternal(
      view,
      dest,
      message.init ?? undefined,
      message.body,
      this.#now(dest),
    );
    if (verdict !== 'ok') {
      throw new Error(
        `LITE_SERVER_UNKNOWN: cannot apply external message to current state : ${verdict}`,
      );
    }
    this.#sends.set(hashNorm, (this.#sends.get(hashNorm) ?? 0) + 1);
    const hash = cell.hash().toString('hex');
    if (!this.swallow && !this.#pending.some((p) => p.hash === hash)) {
      this.#pending.push({ boc, cell, hash });
    }
    return { hash, hashNorm };
  }

  /** Chain time at `account`: its shard block's time, older than the masterchain's. */
  #now(account: string): number {
    return Math.floor(this.#clock.now() / 1000) - this.#shardLag(account);
  }

  /**
   * The lag of the shard holding `account`: the first bit of its address picks one of two
   * shards (the masterchain has no lag).
   */
  #shardLag(account: string): number {
    if (account.startsWith('-1:')) return 0;
    const second = this.shardCount === 2 && Number.parseInt(account.charAt(2), 16) >= 8;
    return second ? this.secondShardLagSeconds : this.shardLagSeconds;
  }

  #account(address: string): Account {
    let account = this.#accounts.get(address);
    if (!account) {
      account = {
        balance: 0n,
        status: 'uninitialized',
        lastLt: 0n,
        lastHash: '0'.repeat(64),
      };
      this.#accounts.set(address, account);
    }
    return account;
  }

  #walletFromInit(
    dest: string,
    init: { code?: Cell | null; data?: Cell | null } | undefined,
  ): Wallet | undefined {
    if (!init?.code || !init.data) return undefined;
    const stateInit = beginCell()
      .storeBit(false)
      .storeBit(false)
      .storeMaybeRef(init.code)
      .storeMaybeRef(init.data)
      .storeBit(false)
      .endCell();
    if (`${dest.split(':')[0]}:${stateInit.hash().toString('hex')}` !== dest)
      return undefined;
    const data = init.data.beginParse();
    if (init.code.hash().equals(WALLET_CODE.v4r2.hash())) {
      const seqno = data.loadUint(32);
      const walletId = data.loadUint(32);
      return { version: 'v4r2', seqno, walletId, publicKey: data.loadBuffer(32) };
    }
    if (init.code.hash().equals(WALLET_CODE.v5r1.hash())) {
      data.loadBit();
      const seqno = data.loadUint(32);
      const walletId = data.loadInt(32);
      return { version: 'v5r1', seqno, walletId, publicKey: data.loadBuffer(32) };
    }
    return undefined;
  }

  /**
   * Whether the liteserver accepts an external against `view`: 'ok', or the chain's own
   * refusal text (live toncenter, external-message.cpp, collator.cpp, transaction.cpp), in
   * the chain's order:
   * - an account that does not exist cannot be loaded;
   * - the balance pays the import fee before any code runs (`unpack_input_msg`);
   * - a frozen account, or one without code or a matching `StateInit`, runs nothing (its
   *   compute phase is skipped): a frozen wallet is never revived by its deploy `StateInit`,
   *   which never matches the frozen state's hash;
   * - the wallet code's checks, in its order, until `accept_message` (the liteserver stops
   *   there, so a request its balance cannot finish is still accepted).
   */
  #checkExternal(
    view: ReadonlyMap<string, Account>,
    dest: string,
    init: { code?: Cell | null; data?: Cell | null } | undefined,
    body: Cell,
    now: number,
  ): string {
    const account = view.get(dest);
    if (!account || v3Status(account) === 'nonexist') {
      return 'Failed to unpack account state';
    }
    const hex = dest.slice(dest.indexOf(':') + 1).toUpperCase();
    const run = 'External message was not accepted: cannot run message on account: ';
    const rejected = (exitCode: number, steps = VM_STEPS): string =>
      `${run}inbound external message rejected by transaction ${hex}:\nexitcode=${exitCode}, steps=${steps}, gas_used=0`;
    if (account.balance < NODE_FEES.importFee) {
      return `${run}inbound external message rejected by account ${hex} before smart-contract execution`;
    }
    const wallet =
      account.status === 'active'
        ? account.wallet
        : account.status === 'uninitialized'
          ? this.#walletFromInit(dest, init)
          : undefined;
    if (!wallet) return rejected(0, 0);
    const request = parseRequest(wallet.version, body);
    if (!request) return rejected(9);
    const codes =
      wallet.version === 'v4r2'
        ? { seqno: 33, id: 34, sig: 35, expired: 36 }
        : { seqno: 133, id: 134, sig: 135, expired: 136 };
    const signed = ed25519.verify(request.signature, request.digest, wallet.publicKey);
    // Each contract's own order of checks (wallet-v4-code.fc, wallet_v5.fc).
    const checks: readonly (readonly [boolean, number])[] =
      wallet.version === 'v4r2'
        ? [
            [request.validUntil > now, codes.expired],
            [request.seqno === wallet.seqno, codes.seqno],
            [request.walletId === wallet.walletId, codes.id],
            [signed, codes.sig],
          ]
        : [
            [signed, codes.sig],
            [request.seqno === wallet.seqno, codes.seqno],
            [request.walletId === wallet.walletId, codes.id],
            [request.validUntil > now, codes.expired],
          ];
    for (const [passed, code] of checks) if (!passed) return rejected(code);
    return 'ok';
  }

  #walletGas(version: 'v4r2' | 'v5r1', deploy: boolean): bigint {
    return (
      (version === 'v4r2' ? NODE_FEES.gasV4 : NODE_FEES.gasV5) +
      (deploy ? NODE_FEES.deployGas : 0n)
    );
  }

  #mineOne(): void {
    const seqno = this.head + 1;
    // Internal messages created in earlier blocks are delivered first.
    const ready = this.#queue.filter((q) => q.readyAt <= seqno);
    for (const item of ready) this.#queue.splice(this.#queue.indexOf(item), 1);
    for (const item of ready) {
      this.#deliver(item, seqno, this.#now(item.msg.destination));
    }
    const pending = this.#pending.splice(0);
    for (const item of pending) this.#processExternal(item.cell, seqno);
    this.#seal();
  }

  #hashOf(kind: string): string {
    this.#counter += 1;
    return sha(`${kind}:${this.#counter}`).toString('hex');
  }

  /**
   * Records a transaction as the chain does: its cell (block.tlb
   * `transaction$0111`, transaction.cpp `Transaction::serialize`) links to the account's
   * previous transaction, and the cell's hash names it (`last_trans_hash_ =
   * root->get_hash()`). Without a `traceId`, it is its trace's root, named after itself.
   */
  #record(
    tx: Omit<Tx, 'hash' | 'lt' | 'raw' | 'prevLt' | 'prevHash' | 'traceId'> & {
      readonly traceId?: string;
    },
  ): Tx {
    this.#lt += 1000n;
    const account = this.#account(tx.account);
    const lt = this.#lt;
    const raw = rawTransaction(tx, lt, account.lastLt, account.lastHash);
    const hash = raw.hash().toString('hex');
    const full: Tx = {
      ...tx,
      traceId: tx.traceId ?? hash,
      hash,
      lt,
      raw,
      prevLt: account.lastLt,
      prevHash: account.lastHash,
    };
    account.lastLt = lt;
    account.lastHash = hash;
    // An account left non-existing is `account_none` (transaction.cpp `compute_state`:
    // uninitialized, not activated, zero balance), which the collator never stores: no chain.
    if (tx.endStatus === 'nonexist') {
      account.lastLt = 0n;
      account.lastHash = '0'.repeat(64);
    }
    this.#txs.push(full);
    return full;
  }

  /**
   * transaction.cpp `acc_delete_req` (+128+32 with the balance at zero): the code, data and
   * seqno go. The account is deleted, and the collator drops it from ShardAccounts with its
   * last transaction (collator.cpp `lookup_delete`), so a later transaction starts a new
   * chain (`init_new`: `last_trans_lt_ = 0`); one holding an extra currency stays,
   * uninitialized, in the same chain (`remaining_balance.is_zero() ? acc_deleted :
   * acc_uninit`).
   */
  #destroy(address: string): void {
    const account = this.#account(address);
    account.status = 'uninitialized';
    delete account.wallet;
    if (!account.extraCurrency) {
      account.lastLt = 0n;
      account.lastHash = '0'.repeat(64);
    }
  }

  #send(msg: Msg, traceId: string, seqno: number): void {
    this.#queue.push({ msg, traceId, readyAt: seqno + 1 });
  }

  #internal(
    source: string,
    destination: string,
    value: bigint,
    bounce: boolean,
    body: Cell,
    bounced = false,
  ): Msg {
    // A unique creation lt, as the chain gives each message (the hash then names it).
    this.#counter += 1;
    const message: Message = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce,
        bounced,
        src: Address.parseRaw(source),
        dest: Address.parseRaw(destination),
        value: { coins: value },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: BigInt(this.#counter),
        createdAt: 0,
      },
      body,
    };
    return {
      hash: beginCell().store(storeMessage(message)).endCell().hash().toString('hex'),
      source,
      destination,
      value,
      bounce,
      bounced,
      body,
      message,
    };
  }

  /**
   * The action phase (transaction.cpp `try_action_send_message`), all or nothing. Each
   * message's send mode decides who pays its forward fee (+1: the balance, on top of the
   * value; else the value) and whether an unpayable message is skipped (+2) or fails the
   * phase with 37 (`no_funds`), whether the balance cannot pay it or its value cannot pay
   * its own fee. A failed phase sends nothing and leaves the balance; the list stays valid
   * and earlier skips count. +128 carries the whole remaining balance, its fees out of it
   * (`act_rec.mode &= ~1`); +128+32 (`(mode & 0xa0) == 0xa0`) then asks to delete the
   * account. A flag this node does not model (+16, +64 included) fails the phase
   * (34), never guessed. Only +16 would bounce an action failure, so none bounces here.
   */
  #actions(account: Account, from: string, requested: readonly Requested[]): Actions {
    let balance = account.balance;
    let forwardFees = 0n;
    let skipped = 0;
    let destroy = false;
    const out: Msg[] = [];
    for (const { mode, message } of requested) {
      if (message.info.type !== 'internal' || (mode & ~(1 | 2 | 32 | 128)) !== 0) {
        return { ok: false, resultCode: 34, skipped };
      }
      const fwd = forwardFee(message, from);
      const all = (mode & 128) !== 0;
      const value = all ? balance : message.info.value.coins;
      const separately = !all && (mode & 1) !== 0;
      const cost = separately ? value + fwd : value;
      if ((!separately && value < fwd) || balance < cost) {
        if ((mode & 2) === 0) return { ok: false, resultCode: 37, skipped };
        skipped += 1;
        continue;
      }
      balance -= cost;
      forwardFees += fwd;
      out.push(
        this.#internal(
          from,
          rawOf(message.info.dest),
          separately ? value : value - fwd,
          message.info.bounce,
          message.body,
        ),
      );
      if (all && (mode & 32) !== 0) destroy = true;
    }
    account.balance = balance;
    return { ok: true, out, forwardFees, skipped, ...(destroy ? { destroy } : {}) };
  }

  #processExternal(cell: Cell, seqno: number): void {
    const message = loadMessage(cell.beginParse());
    if (message.info.type !== 'external-in') return;
    const dest = rawOf(message.info.dest);
    const now = this.#now(dest);
    // Re-checked against the state at inclusion: a message that no longer applies is
    // never included and leaves no trace (it may still be retried until it expires).
    const init = message.init ?? undefined;
    if (this.#checkExternal(this.#accounts, dest, init, message.body, now) !== 'ok')
      return;
    const origStatus = v3Status(this.#accounts.get(dest));
    const account = this.#account(dest);
    const deploy = account.status !== 'active';
    const wallet = {
      ...(deploy
        ? (this.#walletFromInit(dest, init) as Wallet)
        : (account.wallet as Wallet)),
    };
    const request = parseRequest(wallet.version, message.body) as Request;
    const fees = NODE_FEES.importFee + this.#walletGas(wallet.version, deploy);
    // A balance that pays the import and the accept, not the whole run: the gas runs out
    // after `accept_message`, so the chain includes it out of gas (-14), taking the whole
    // balance and keeping the seqno (the compute phase's state is dropped).
    const outOfGas = account.balance < fees;
    const charged = outOfGas ? account.balance : fees;
    account.balance -= charged;
    // The `StateInit` activates the account whatever happens next (transaction.cpp).
    account.status = 'active';
    account.wallet = wallet;
    // The root of its trace: the trace is named after it, as toncenter's `trace_id`.
    const record = (
      totalFees: bigint,
      description: Record<string, unknown>,
      outMsgs: readonly Msg[],
      endStatus: V3Status = 'active',
    ): Tx =>
      this.#record({
        account: dest,
        now,
        mcSeqno: seqno,
        totalFees,
        origStatus,
        endStatus,
        description: { type: 'ord', ...description },
        inMsg: {
          hash: cell.hash().toString('hex'),
          source: null,
          destination: dest,
          value: null,
          bounce: false,
          bounced: false,
          body: message.body,
          hashNorm: normalizedHash(cell),
          ...(init
            ? { initState: beginCell().store(storeStateInit(init)).endCell() }
            : {}),
          message,
        },
        outMsgs,
      });
    if (outOfGas) {
      record(
        charged,
        {
          aborted: true,
          compute_ph: { skipped: false, success: false, exit_code: -14 },
        },
        [],
      );
      return;
    }
    if (request.withoutIgnoreErrors) {
      // wallet_v5.fc: `commit()` stores the next seqno with an empty action list, then the
      // contract throws 137. transaction.cpp: `success = accepted && committed`, so the
      // compute phase succeeded (with 137), the committed empty list runs, and the
      // transaction is not aborted.
      wallet.seqno += 1;
      record(
        fees,
        {
          aborted: false,
          compute_ph: { skipped: false, success: true, exit_code: 137 },
          action: actionPhase({ ok: true, out: [], forwardFees: 0n, skipped: 0 }, 0),
        },
        [],
      );
      return;
    }
    const computed = { skipped: false, success: true, exit_code: 0 };
    const actions = this.#actions(account, dest, request.messages);
    if (!actions.ok) {
      // The action phase failed: the seqno (c4) and every message roll back, the gas stays
      // paid, and the same message applies again until it expires.
      record(
        fees,
        {
          aborted: true,
          compute_ph: computed,
          action: actionPhase(actions, request.messages.length),
        },
        [],
      );
      return;
    }
    wallet.seqno += 1;
    const tx = record(
      fees + actions.forwardFees,
      {
        aborted: false,
        compute_ph: computed,
        action: actionPhase(actions, request.messages.length),
        ...(actions.destroy ? { destroyed: true } : {}),
      },
      actions.out,
      actions.destroy ? (account.extraCurrency ? 'uninit' : 'nonexist') : 'active',
    );
    if (actions.destroy) this.#destroy(dest);
    for (const msg of actions.out) this.#send(msg, tx.traceId, seqno);
  }

  #deliver(item: Queued, seqno: number, now: number): void {
    const { msg, traceId } = item;
    const origStatus = v3Status(this.#accounts.get(msg.destination));
    const account = this.#account(msg.destination);
    const value = msg.value ?? 0n;
    const out: Msg[] = [];
    let aborted = false;
    let destroy = false;
    let compute: Record<string, unknown> = {
      skipped: false,
      success: true,
      exit_code: 0,
    };
    let action: Record<string, unknown> | undefined;
    let bounce: Record<string, unknown> | undefined;
    /**
     * The compute phase failed: the transaction aborts, and a bounceable message bounces
     * if its value pays for the bounce (collator.cpp runs the bounce phase only then).
     */
    const fail = (exitCode: number, skipReason?: string): void => {
      aborted = true;
      compute = skipReason
        ? { skipped: true, reason: skipReason }
        : { skipped: false, success: false, exit_code: exitCode };
      if (!msg.bounce || msg.bounced) return;
      const back = value - NODE_FEES.internalGas;
      if (back < 0n) {
        // Below the bounce's cost (strictly, transaction.cpp `prepare_bounce_phase`):
        // `nofunds`, and the value stays here.
        bounce = { type: 'nofunds' };
        return;
      }
      bounce = { type: 'ok' };
      account.balance -= value;
      out.push(
        this.#internal(
          msg.destination,
          msg.source as string,
          back,
          false,
          bouncedBody(msg.body),
          true,
        ),
      );
    };
    account.balance += value;
    const op = opOf(msg.body);
    // A standard jetton wallet's `internal_transfer` carries its `StateInit`.
    const jettonIdentity =
      op === OP.internalTransfer
        ? (account.jettonWallet ?? this.#jettonWallets.get(msg.destination))
        : undefined;
    if (msg.bounced) {
      // A bounced internal_transfer returns its amount to the sending jetton wallet.
      if (account.jettonWallet && bouncedOp(msg.body) === OP.internalTransfer) {
        account.jettonWallet.balance += bouncedAmount(msg.body);
      }
    } else if (
      account.status === 'frozen' ||
      (account.status === 'uninitialized' && !jettonIdentity)
    ) {
      fail(0, 'no_state');
    } else if (op === OP.signedInternal && account.wallet?.version === 'v5r1') {
      // wallet_v5.fc `recv_internal`: a relayed signed request. A failing signature is
      // ignored (the transaction succeeds and changes nothing); otherwise the seqno, wallet
      // id and lifetime are checked (133, 134, 136), the seqno set, the actions run. With
      // no `commit()` here, a failed action phase rolls the seqno back.
      const wallet = account.wallet;
      const request = parseRequest('v5r1', msg.body, OP.signedInternal);
      if (
        request &&
        ed25519.verify(request.signature, request.digest, wallet.publicKey)
      ) {
        if (request.seqno !== wallet.seqno) fail(133);
        else if (request.walletId !== wallet.walletId) fail(134);
        else if (request.validUntil <= now) fail(136);
        else {
          const actions = this.#actions(account, msg.destination, request.messages);
          action = actionPhase(actions, request.messages.length);
          if (actions.ok) {
            wallet.seqno += 1;
            out.push(...actions.out);
            destroy = actions.destroy === true;
          } else {
            // The action phase failed: the seqno rolls back (no `commit()` here), and with
            // no +16 nothing bounces, so the relayed value stays at the wallet.
            aborted = true;
          }
        }
      }
    } else if (account.reverter) {
      fail(100);
    } else if (op === OP.transfer && account.jettonWallet) {
      const t = parseTransfer(msg.body);
      const jw = account.jettonWallet;
      if (
        !t ||
        msg.source !== jw.owner ||
        jw.balance < t.amount ||
        value < NODE_FEES.jettonGas + t.forwardAmount
      ) {
        fail(47);
      } else {
        jw.balance -= t.amount;
        account.balance -= value;
        const to = this.jettonWalletOf(jw.master, t.destination);
        const body = beginCell()
          .storeUint(OP.internalTransfer, 32)
          .storeUint(t.queryId, 64)
          .storeCoins(t.amount)
          .storeAddress(Address.parseRaw(jw.owner))
          .storeAddress(t.response === null ? null : Address.parseRaw(t.response))
          .storeCoins(t.forwardAmount)
          .storeSlice(t.forwardPayload)
          .endCell();
        out.push(
          this.#internal(msg.destination, to, value - NODE_FEES.internalGas, true, body),
        );
      }
    } else if (jettonIdentity) {
      const t = parseInternalTransfer(msg.body);
      const { master } = jettonIdentity;
      const sender = msg.source as string;
      // The `StateInit` deploys the jetton wallet with its initial data (no jettons), and
      // that stays whatever the outcome: a later transfer meets the balance check.
      account.status = 'active';
      account.jettonWallet = account.jettonWallet ?? {
        master,
        owner: jettonIdentity.owner,
        balance: 0n,
      };
      const jw = account.jettonWallet;
      if (!t) fail(9);
      // TEP-74 `receive_tokens`: only the master, or the sending owner's own jetton wallet.
      else if (
        sender !== master &&
        (t.from === null || sender !== jettonWalletAddress(master, t.from))
      ) {
        fail(707);
      } else if (this.#failing.has(msg.destination)) fail(709);
      else {
        jw.balance += t.amount;
        account.balance -= value;
        let rest = value - NODE_FEES.internalGas;
        if (t.forwardAmount > 0n) {
          const note = beginCell()
            .storeUint(OP.notification, 32)
            .storeUint(t.queryId, 64)
            .storeCoins(t.amount)
            .storeAddress(t.from ? Address.parseRaw(t.from) : null)
            .storeSlice(t.forwardPayload)
            .endCell();
          out.push(
            this.#internal(msg.destination, jw.owner, t.forwardAmount, false, note),
          );
          rest -= t.forwardAmount;
        }
        if (t.response && rest > 0n) {
          const excess = beginCell()
            .storeUint(OP.excesses, 32)
            .storeUint(t.queryId, 64)
            .endCell();
          out.push(this.#internal(msg.destination, t.response, rest, false, excess));
        }
      }
    }
    const tx = this.#record({
      account: msg.destination,
      now,
      mcSeqno: seqno,
      // A delivery is its trace's root when injected: named after itself.
      ...(item.root ? {} : { traceId }),
      totalFees: NODE_FEES.internalGas,
      origStatus,
      endStatus: destroy
        ? account.extraCurrency
          ? 'uninit'
          : 'nonexist'
        : v3Status(account),
      description: {
        type: 'ord',
        aborted,
        ...(destroy ? { destroyed: true } : {}),
        compute_ph: compute,
        ...(action
          ? { action }
          : aborted
            ? {}
            : {
                action: actionPhase(
                  { ok: true, out, forwardFees: 0n, skipped: 0 },
                  out.length,
                ),
              }),
        ...(bounce ? { bounce } : {}),
      },
      inMsg: msg,
      outMsgs: out,
    });
    if (destroy) this.#destroy(msg.destination);
    for (const next of out) this.#send(next, tx.traceId, seqno);
  }

  readonly #failing = new Set<string>();

  /** Makes the jetton wallet at `address` fail every `internal_transfer` (it bounces). */
  failJettonWallet(address: string): void {
    this.#failing.add(normalizeParam(address));
  }

  #seal(): void {
    const seqno = this.#blocks.length === 0 ? 1 : this.head + 1;
    const genUtime = Math.floor(this.#clock.now() / 1000);
    this.#blocks.push({
      seqno,
      genUtime,
      rootHash: sha(`mc-root:${seqno}`).toString('hex'),
      fileHash: sha(`mc-file:${seqno}`).toString('hex'),
      shards: SHARD_SETS[this.shardCount].map((shard, index) => ({
        shard,
        seqno: seqno + 1000 * (index + 1),
        genUtime:
          genUtime - (index === 0 ? this.shardLagSeconds : this.secondShardLagSeconds),
        rootHash: sha(`shard-root:${index}:${seqno}`).toString('hex'),
        fileHash: sha(`shard-file:${index}:${seqno}`).toString('hex'),
      })),
      state: this.#snapshot(),
    });
  }

  /** Scripted state changes become visible in the newest block's snapshot. */
  #sealState(): void {
    const last = this.#blocks.at(-1) as Block;
    this.#blocks[this.#blocks.length - 1] = { ...last, state: this.#snapshot() };
  }

  #snapshot(): Map<string, Account> {
    return new Map([...this.#accounts].map(([k, v]) => [k, cloneAccount(v)]));
  }

  // ---- HTTP -----------------------------------------------------------------------------

  #serve(
    name: string,
    api: 'v2' | 'v3',
    request: FakeRequest,
    signal: AbortSignal | undefined,
  ): FakeReply | Promise<FakeReply> {
    const route = request.url.pathname.replace(/^\/api\/v[23]/, '');
    this.served.push({ endpoint: name, route });
    const intercepted = this.intercept?.(name, route, request, signal);
    if (intercepted !== undefined) return intercepted;
    try {
      return api === 'v2' ? this.#v2(name, route, request) : this.#v3(route, request);
    } catch (error) {
      // Each API's own envelope: v2 `{ ok: false, error, code }`, v3 `{ error }`.
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ParamError ? 422 : 500;
      return api === 'v2'
        ? { status, json: { ok: false, error: message, code: status } }
        : { status, json: { error: message } };
    }
  }

  #viewHead(name: string): number {
    return Math.max(1, this.head - (this.#lag.get(name) ?? 0));
  }

  #blockAt(name: string, seqno: string | null): Block {
    const head = this.#viewHead(name);
    const wanted = seqno === null ? head : Number(seqno);
    const block = this.block(wanted);
    if (!block || wanted > head) {
      throw new Error(
        `LITE_SERVER_NOTREADY: cannot find block (-1,8000000000000000) seqno=${wanted}: ltdb: block not found`,
      );
    }
    return block;
  }

  #v2(name: string, route: string, request: FakeRequest): FakeReply {
    const q = request.url.searchParams;
    const ok = (result: unknown): FakeReply => ({
      json: { ok: true, result, '@extra': 'x' },
    });
    const mcId = mcBlockId;
    const shardId = (top: Block['shards'][number]) => ({
      '@type': 'ton.blockIdExt',
      workchain: 0,
      shard: top.shard,
      seqno: top.seqno,
      root_hash: b64(Buffer.from(top.rootHash, 'hex')),
      file_hash: b64(Buffer.from(top.fileHash, 'hex')),
    });
    switch (route) {
      case '/jsonRPC': {
        // `TonClient`'s JSON-RPC path: the same methods, parameters in the body.
        const { method, params } = request.json<{
          method: string;
          params?: Record<string, unknown>;
        }>();
        const url = new URL(request.url.href.replace(/\/jsonRPC$/, `/${method}`));
        for (const [key, value] of Object.entries(params ?? {})) {
          if (typeof value !== 'object') url.searchParams.set(key, String(value));
        }
        return this.#v2(name, `/${method}`, {
          ...request,
          url,
          json: <T>() => (params ?? {}) as T,
        });
      }
      case '/getMasterchainInfo': {
        const head = this.#blockAt(name, null);
        return ok({
          state_root_hash: b64(sha('state')),
          last: mcId(head),
          init: mcId(this.#blocks[0] as Block),
        });
      }
      case '/getBlockHeader': {
        const workchain = Number(q.get('workchain'));
        const wanted = Number(q.get('seqno'));
        if (workchain === -1) {
          const block = this.#blockAt(name, String(wanted));
          const prev = this.block(block.seqno - 1);
          return ok({
            '@type': 'blocks.header',
            id: mcId(block),
            global_id: this.globalId,
            gen_utime: block.genUtime,
            prev_blocks: prev ? [mcId(prev)] : [],
          });
        }
        const index = SHARD_SETS[this.shardCount].indexOf(q.get('shard') ?? '');
        if (index < 0) throw new Error('LITE_SERVER_UNKNOWN: block not found');
        const block = this.#blockAt(name, String(wanted - 1000 * (index + 1)));
        const top = block.shards[index];
        if (!top || top.seqno !== wanted)
          throw new Error('LITE_SERVER_UNKNOWN: block not found');
        return ok({
          '@type': 'blocks.header',
          id: shardId(top),
          global_id: this.globalId,
          gen_utime: top.genUtime,
          prev_blocks: [],
        });
      }
      case '/getShards': {
        const block = this.#blockAt(name, q.get('seqno'));
        return ok({ '@type': 'blocks.shards', shards: block.shards.map(shardId) });
      }
      case '/getConfigParam': {
        const param = Number(q.get('param'));
        const bytes =
          param === 19
            ? beginCell().storeInt(this.globalId, 32).endCell().toBoc().toString('base64')
            : param === 25
              ? MSG_PRICES_BOC
              : param === 24
                ? MC_MSG_PRICES_BOC
                : param === 21
                  ? gasPricesBoc(NODE_FEES.flatGasPrice, 400n)
                  : param === 20
                    ? gasPricesBoc(NODE_FEES.mcFlatGasPrice, 10_000n)
                    : null;
        if (bytes === null) throw new Error('config param not found');
        return ok({ '@type': 'configInfo', config: { '@type': 'tvm.cell', bytes } });
      }
      case '/getAddressInformation': {
        const block = this.#blockAt(name, q.get('seqno'));
        const address = normalizeParam(q.get('address'));
        const account = block.state.get(address);
        return ok({
          '@type': 'raw.fullAccountState',
          balance: (account?.balance ?? 0n).toString(),
          last_transaction_id: {
            '@type': 'internal.transactionId',
            lt: (account?.lastLt ?? 0n).toString(),
            hash: b64(Buffer.from(account?.lastHash ?? '0'.repeat(64), 'hex')),
          },
          block_id: mcId(block),
          code: '',
          data: '',
          frozen_hash: '',
          sync_utime: block.genUtime,
          state: account?.status ?? 'uninitialized',
        });
      }
      case '/runGetMethod': {
        const body = request.json<{
          address: string;
          method: string;
          stack: [string, string][];
          seqno?: number;
        }>();
        const block = this.#blockAt(
          name,
          body.seqno === undefined ? null : String(body.seqno),
        );
        return ok(
          this.#getMethod(block, normalizeParam(body.address), body.method, body.stack),
        );
      }
      case '/estimateFee': {
        const body = request.json<{
          address: string;
          body: string;
          init_code: string;
          init_data?: string;
        }>();
        const address = normalizeParam(body.address);
        // The endpoint emulates on its own view of the chain.
        const account = this.#blockAt(name, null).state.get(address);
        const deployed = account?.status === 'active' ? account.wallet : undefined;
        const fees = (gas: bigint, fwd: bigint) =>
          ok({
            '@type': 'query.fees',
            source_fees: {
              '@type': 'fees',
              in_fwd_fee: Number(NODE_FEES.importFee),
              storage_fee: 0,
              gas_fee: Number(gas),
              fwd_fee: Number(fwd),
            },
            destination_fees: [],
          });
        const cellOf = (boc: string | undefined) =>
          boc ? (Cell.fromBoc(Buffer.from(boc, 'base64'))[0] ?? null) : null;
        // An active account runs its own code (a `StateInit` is ignored); otherwise only a
        // `StateInit` whose hash is the address deploys it.
        const wallet =
          deployed ??
          this.#walletFromInit(address, {
            code: cellOf(body.init_code),
            data: cellOf(body.init_data),
          });
        // No wallet in this view and no usable `StateInit`: no code runs, so nothing is
        // sent, and toncenter reports the flat gas price (seen live).
        if (!wallet) return fees(NODE_FEES.flatGas, 0n);
        // tonlib `Query::estimate_fees` buys the run's gas with the balance
        // (`compute_gas_limits`), and reports `gas_fee` only for an accepted run and
        // `fwd_fee` only for a successful one. No balance buys no gas.
        const balance = account?.balance ?? 0n;
        if (balance < NODE_FEES.flatGas) return fees(0n, 0n);
        // The wallet code's own checks run before its accept (`ignore_chksig` skips only the
        // signature): another seqno, wallet id or an expired request runs nothing.
        const request_ = parseRequest(
          wallet.version,
          Cell.fromBoc(Buffer.from(body.body, 'base64'))[0] as Cell,
        );
        if (
          !request_ ||
          request_.seqno !== wallet.seqno ||
          request_.walletId !== wallet.walletId ||
          request_.validUntil <= this.#now(address)
        ) {
          return fees(0n, 0n);
        }
        // Accepted, but the balance cannot pay the whole run: out of gas, nothing sent.
        const gas = this.#walletGas(wallet.version, !deployed);
        if (balance < gas) return fees(balance, 0n);
        // The real action list's forward fees, as a liteserver's emulation reports them.
        const fwd = request_.messages.reduce(
          (sum, m) => sum + forwardFee(m.message, address),
          0n,
        );
        return fees(gas, fwd);
      }
      case '/getTransactions': {
        // The liteserver's own list: from the transaction (lt, hash) back along the
        // account's `prev_trans` links, each with its raw cell (`data`), as far as this
        // endpoint's view holds them.
        const address = normalizeParam(q.get('address'));
        const limit = Number(q.get('limit') ?? '10');
        const lt = bigParam(q.get('lt'));
        const hash = q.get('hash');
        const view = this.#viewHead(name);
        const held = new Map(
          this.#txs
            .filter((t) => t.account === address && t.mcSeqno <= view)
            .map((t) => [t.hash, t]),
        );
        const newest = [...held.values()].at(-1);
        let at: Tx | undefined =
          lt !== null && hash !== null ? held.get(hexParam(hash)) : newest;
        if (lt !== null && at?.lt !== lt) {
          throw new Error('LITE_SERVER_UNKNOWN: cannot load transaction: not found');
        }
        const rows: unknown[] = [];
        while (at && rows.length < limit) {
          const t: Tx = at;
          rows.push({
            '@type': 'raw.transaction',
            address: { '@type': 'accountAddress', account_address: address },
            utime: t.now,
            data: t.raw.toBoc().toString('base64'),
            transaction_id: transactionId(t.lt, t.hash),
            fee: t.totalFees.toString(),
            storage_fee: '0',
            other_fee: '0',
          });
          at = t.prevLt === 0n ? undefined : held.get(t.prevHash);
        }
        return ok(rows);
      }
      case '/sendBocReturnHash': {
        const { boc } = request.json<{ boc: string }>();
        // Checked against this endpoint's own view, then again at inclusion.
        const sent = this.#submit(boc, this.#blockAt(name, null).state);
        return ok({
          '@type': 'raw.extMessageInfo',
          hash: b64(Buffer.from(sent.hash, 'hex')),
          hash_norm: b64(Buffer.from(sent.hashNorm, 'hex')),
        });
      }
      default:
        return {
          status: 404,
          json: { ok: false, error: 'method is not supported', code: 404 },
        };
    }
  }

  #getMethod(
    block: Block,
    address: string,
    method: string,
    stack: [string, string][],
  ): unknown {
    const account = block.state.get(address);
    // Live toncenter names the masterchain block and the account's last transaction.
    const result = (exitCode: number, entries: unknown[]) => ({
      '@type': 'smc.runResult',
      gas_used: 100,
      stack: entries,
      exit_code: exitCode,
      block_id: mcBlockId(block),
      last_transaction_id: transactionId(
        account?.lastLt ?? 0n,
        account?.lastHash ?? '0'.repeat(64),
      ),
    });
    if (!account || account.status !== 'active') return result(-13, []);
    const cellOf = (raw: string | null) => [
      'cell',
      {
        bytes: beginCell()
          .storeAddress(raw ? Address.parseRaw(raw) : null)
          .endCell()
          .toBoc()
          .toString('base64'),
      },
    ];
    if (method === 'seqno' && account.wallet) {
      return result(0, [['num', `0x${account.wallet.seqno.toString(16)}`]]);
    }
    if (method === 'get_public_key' && account.wallet) {
      return result(0, [['num', `0x${account.wallet.publicKey.toString('hex')}`]]);
    }
    if (method === 'get_wallet_address' && account.jetton) {
      const arg = stack[0]?.[1];
      const owner = arg
        ? (Cell.fromBoc(Buffer.from(arg, 'base64'))[0] as Cell).beginParse().loadAddress()
        : null;
      if (!owner) return result(9, []);
      return result(0, [cellOf(this.jettonWalletOf(address, rawOf(owner)))]);
    }
    if (method === 'get_jetton_data' && account.jetton) {
      return result(0, [
        ['num', '0x5f5e100'],
        ['num', '-0x1'],
        cellOf(null),
        ['cell', { bytes: jettonContent(account.jetton).toBoc().toString('base64') }],
        ['cell', { bytes: beginCell().endCell().toBoc().toString('base64') }],
      ]);
    }
    if (method === 'get_wallet_data' && account.jettonWallet) {
      const jw = account.jettonWallet;
      return result(0, [
        ['num', `0x${jw.balance.toString(16)}`],
        cellOf(jw.owner),
        cellOf(jw.master),
        ['cell', { bytes: beginCell().endCell().toBoc().toString('base64') }],
      ]);
    }
    return result(11, []);
  }

  #v3(route: string, request: FakeRequest): FakeReply {
    const q = request.url.searchParams;
    const indexed = this.#txs.filter((t) => t.mcSeqno <= this.indexed);
    const book = { address_book: {} };
    switch (route) {
      case '/masterchainInfo': {
        const last = this.block(this.indexed) as Block;
        const first = this.#blocks[0] as Block;
        const view = (b: Block) => ({
          workchain: -1,
          shard: '8000000000000000',
          seqno: b.seqno,
          root_hash: b64(Buffer.from(b.rootHash, 'hex')),
          file_hash: b64(Buffer.from(b.fileHash, 'hex')),
          global_id: this.globalId,
          gen_utime: String(b.genUtime),
        });
        return { json: { last: view(last), first: view(first) } };
      }
      case '/blocks': {
        const wanted = hexParam(q.get('root_hash'));
        const block = this.#blocks.find(
          (b) => b.rootHash === wanted && b.seqno <= this.indexed,
        );
        return {
          json: {
            blocks: block
              ? [
                  {
                    workchain: -1,
                    shard: '8000000000000000',
                    seqno: block.seqno,
                    root_hash: b64(Buffer.from(block.rootHash, 'hex')),
                    file_hash: b64(Buffer.from(block.fileHash, 'hex')),
                    global_id: this.globalId,
                    gen_utime: String(block.genUtime),
                  },
                ]
              : [],
          },
        };
      }
      case '/transactionsByMessage': {
        const wanted = hexParam(q.get('msg_hash'));
        const found = indexed.filter(
          (t) => t.inMsg.hash === wanted || t.inMsg.hashNorm === wanted,
        );
        return { json: { transactions: found.map((t) => txJson(t)), ...book } };
      }
      case '/transactions': {
        const hash = q.get('hash');
        if (hash !== null) {
          const wanted = hexParam(hash);
          return {
            json: {
              transactions: indexed.filter((t) => t.hash === wanted).map(txJson),
              ...book,
            },
          };
        }
        const account = normalizeParam(q.get('account'));
        const endLt = bigParam(q.get('end_lt'));
        const limit = Number(q.get('limit') ?? '10');
        const list = indexed
          .filter((t) => t.account === account && (endLt === null || t.lt <= endLt))
          .sort((a, b) => (a.lt < b.lt ? 1 : -1))
          .slice(0, limit);
        return { json: { transactions: list.map(txJson), ...book } };
      }
      case '/traces': {
        const wanted = hexParam(q.get('tx_hash'));
        const tx = indexed.find((t) => t.hash === wanted);
        if (!tx) return { json: { traces: [], ...book } };
        const members = indexed.filter((t) => t.traceId === tx.traceId);
        const open =
          this.#queue.some((m) => m.traceId === tx.traceId) ||
          this.#txs.some((t) => t.traceId === tx.traceId && t.mcSeqno > this.indexed);
        const root = (members.find((t) => t.hash === tx.traceId) ?? members[0]) as Tx;
        return {
          json: {
            traces: [
              {
                trace_id: b64(Buffer.from(root.hash, 'hex')),
                external_hash:
                  root.inMsg.source === null
                    ? b64(Buffer.from(root.inMsg.hash, 'hex'))
                    : null,
                is_incomplete: open,
                trace_info: {
                  trace_state: open ? 'pending' : 'complete',
                  messages: members.length,
                  transactions: members.length,
                  pending_messages: open ? 1 : 0,
                },
                transactions_order: members.map((t) => b64(Buffer.from(t.hash, 'hex'))),
                transactions: Object.fromEntries(
                  members.map((t) => [b64(Buffer.from(t.hash, 'hex')), txJson(t)]),
                ),
              },
            ],
            ...book,
          },
        };
      }
      case '/jetton/masters': {
        const address = normalizeParam(q.get('address'));
        // The indexer knows only what it has indexed.
        const jetton = (this.block(this.indexed) as Block).state.get(address)?.jetton;
        if (!jetton) return { json: { jetton_masters: [], ...book } };
        const content: Record<string, string> = {};
        if (jetton.decimals !== undefined) content.decimals = String(jetton.decimals);
        if (jetton.symbol !== undefined && jetton.content === 'offchain')
          content.symbol = jetton.symbol;
        return {
          json: {
            jetton_masters: [{ address: upper(address), jetton_content: content }],
            ...book,
          },
        };
      }
      case '/metadata': {
        const address = normalizeParam(q.get('address'));
        // The indexer knows only what it has indexed.
        const jetton = (this.block(this.indexed) as Block).state.get(address)?.jetton;
        return {
          json: jetton?.symbol
            ? {
                [upper(address)]: {
                  is_indexed: true,
                  token_info: [
                    {
                      valid: true,
                      type: 'jetton_masters',
                      symbol: jetton.symbol,
                      // Live toncenter writes the JSON's decimals under `extra`.
                      ...(jetton.decimals !== undefined
                        ? { extra: { decimals: String(jetton.decimals) } }
                        : {}),
                    },
                  ],
                },
              }
            : {},
        };
      }
      default:
        return { status: 404, json: { error: 'route not found' } };
    }
  }
}

// ---- codecs -----------------------------------------------------------------------------

interface Request {
  readonly signature: Buffer;
  readonly digest: Buffer;
  readonly walletId: number;
  readonly validUntil: number;
  readonly seqno: number;
  /** The requested messages, each with its own send mode. */
  readonly messages: readonly Requested[];
  /** W5: an action without send mode +2; the wallet commits the seqno, then throws 137. */
  readonly withoutIgnoreErrors?: boolean;
}

/**
 * The wallet contract's own parse (v4r2: signature first; v5r1: last), keeping each
 * message's send mode; `op` is the v5r1 prefix (external or relayed internally).
 */
function parseRequest(
  version: 'v4r2' | 'v5r1',
  body: Cell,
  op: number = OP.signed,
): Request | null {
  try {
    const n = body.bits.length;
    const rest = (from: number, to: number) => {
      const b = beginCell().storeBits(body.bits.substring(from, to - from));
      for (const ref of body.refs) b.storeRef(ref);
      return b.endCell();
    };
    if (version === 'v4r2') {
      const signature = beginCell()
        .storeBits(body.bits.substring(0, 512))
        .endCell()
        .beginParse()
        .loadBuffer(64);
      const signing = rest(512, n);
      const s = signing.beginParse();
      const walletId = s.loadUint(32);
      const validUntil = s.loadUint(32);
      const seqno = s.loadUint(32);
      if (s.loadUint(8) !== 0) return null;
      const messages: Requested[] = [];
      while (s.remainingRefs > 0) {
        const mode = s.loadUint(8);
        messages.push({ mode, message: loadMessageRelaxed(s.loadRef().beginParse()) });
      }
      return { signature, digest: signing.hash(), walletId, validUntil, seqno, messages };
    }
    const signature = beginCell()
      .storeBits(body.bits.substring(n - 512, 512))
      .endCell()
      .beginParse()
      .loadBuffer(64);
    const signing = rest(0, n - 512);
    const s = signing.beginParse();
    if (s.loadUint(32) !== op) return null;
    const walletId = s.loadInt(32);
    const validUntil = s.loadUint(32);
    const seqno = s.loadUint(32);
    const list = s.loadMaybeRef();
    let withoutIgnoreErrors = false;
    const messages: Requested[] = [];
    for (const action of list ? loadOutList(list.beginParse()) : []) {
      if (action.type === 'sendMsg') {
        if ((action.mode & 2) === 0) withoutIgnoreErrors = true;
        messages.push({ mode: action.mode, message: action.outMsg });
      }
    }
    return {
      signature,
      digest: signing.hash(),
      walletId,
      validUntil,
      seqno,
      messages,
      ...(withoutIgnoreErrors ? { withoutIgnoreErrors } : {}),
    };
  } catch {
    return null;
  }
}

export function normalizedHash(externalCell: Cell): string {
  const message = loadMessage(externalCell.beginParse());
  if (message.info.type !== 'external-in') throw new Error('not external');
  return beginCell()
    .storeUint(2, 2)
    .storeUint(0, 2)
    .storeAddress(message.info.dest)
    .storeCoins(0)
    .storeBit(false)
    .storeBit(true)
    .storeRef(message.body)
    .endCell()
    .hash()
    .toString('hex');
}

/**
 * A message's full forward fee, priced as transaction.cpp `try_action_send_message` does:
 * by config param 24 when the source or the destination is on the masterchain, else 25.
 */
function forwardFee(message: MessageRelaxed, source: string): bigint {
  const cell = beginCell().store(storeMessageRelaxed(message)).endCell();
  const masterchain =
    source.startsWith('-1:') ||
    (message.info.type === 'internal' && message.info.dest.workChain === -1);
  const prices = masterchain ? PRICES.masterchain : PRICES.basechain;
  const { fees, remaining } = computeMessageForwardFees(prices, cell);
  return fees + remaining;
}

function opOf(body: Cell): number | undefined {
  const s = body.beginParse();
  return s.remainingBits >= 32 ? s.loadUint(32) : undefined;
}

function bouncedBody(body: Cell): Cell {
  const s = body.beginParse();
  const bits = Math.min(s.remainingBits, 256);
  return beginCell().storeUint(0xffffffff, 32).storeBits(s.loadBits(bits)).endCell();
}

function bouncedOp(body: Cell): number | undefined {
  const s = body.beginParse();
  if (s.remainingBits < 64 || s.loadUint(32) !== 0xffffffff) return undefined;
  return s.loadUint(32);
}

function bouncedAmount(body: Cell): bigint {
  const s = body.beginParse();
  s.skip(32 + 32 + 64);
  return s.loadCoins();
}

function parseTransfer(body: Cell) {
  try {
    const s = body.beginParse();
    if (s.loadUint(32) !== OP.transfer) return null;
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    const destination = rawOf(s.loadAddress());
    // TEP-74 allows `addr_none` here: no excess is returned.
    const response = s.loadMaybeAddress();
    s.loadMaybeRef();
    const forwardAmount = s.loadCoins();
    return {
      queryId,
      amount,
      destination,
      response: response ? rawOf(response) : null,
      forwardAmount,
      forwardPayload: s,
    };
  } catch {
    return null;
  }
}

function parseInternalTransfer(body: Cell) {
  try {
    const s = body.beginParse();
    if (s.loadUint(32) !== OP.internalTransfer) return null;
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    const from = s.loadMaybeAddress();
    const response = s.loadMaybeAddress();
    const forwardAmount = s.loadCoins();
    return {
      queryId,
      amount,
      from: from ? rawOf(from) : null,
      response: response ? rawOf(response) : null,
      forwardAmount,
      forwardPayload: s,
    };
  } catch {
    return null;
  }
}

/** TEP-64 content: an on-chain dictionary (sha256 keys, snake values) or an off-chain URI. */
function jettonContent(jetton: Jetton): Cell {
  if (jetton.content === 'offchain') {
    return beginCell()
      .storeUint(1, 8)
      .storeStringTail('https://jetton.test/meta.json')
      .endCell();
  }
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  const value = (text: string) =>
    beginCell().storeUint(0, 8).storeStringTail(text).endCell();
  if (jetton.decimals !== undefined)
    dict.set(sha('decimals'), value(String(jetton.decimals)));
  if (jetton.symbol !== undefined) dict.set(sha('symbol'), value(jetton.symbol));
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

function mcBlockId(b: Block): Record<string, unknown> {
  return {
    '@type': 'ton.blockIdExt',
    workchain: -1,
    shard: '-9223372036854775808',
    seqno: b.seqno,
    root_hash: b64(Buffer.from(b.rootHash, 'hex')),
    file_hash: b64(Buffer.from(b.fileHash, 'hex')),
  };
}

function transactionId(lt: bigint, hash: string): Record<string, unknown> {
  return {
    '@type': 'internal.transactionId',
    lt: lt.toString(),
    hash: b64(Buffer.from(hash, 'hex')),
  };
}

/** A message in an `out_msgs` dictionary (block.tlb `HashmapE 15 ^(Message Any)`). */
const MESSAGE_VALUE: DictionaryValue<Message> = {
  serialize: (src, builder) => {
    builder.storeRef(beginCell().store(storeMessage(src)));
  },
  parse: (slice) => loadMessage(slice.loadRef().beginParse()),
};

const RAW_STATUS: Readonly<Record<V3Status, AccountStatus>> = {
  nonexist: 'non-existing',
  uninit: 'uninitialized',
  active: 'active',
  frozen: 'frozen',
};

const NO_SIZE = { cells: 0n, bits: 0n };

/** The chain's own description of a transaction the node wrote in v3's form. */
function rawDescription(
  d: Record<string, unknown>,
  inbound: Msg,
): TransactionDescriptionGeneric {
  const c = d.compute_ph as { skipped: boolean; success?: boolean; exit_code?: number };
  const computePhase: TransactionComputePhase = c.skipped
    ? { type: 'skipped', reason: 'no-state' }
    : {
        type: 'vm',
        success: c.success === true,
        messageStateUsed: false,
        accountActivated: false,
        gasFees: 0n,
        gasUsed: 0n,
        gasLimit: 0n,
        mode: 0,
        exitCode: c.exit_code ?? 0,
        vmSteps: 0,
        vmInitStateHash: 0n,
        vmFinalStateHash: 0n,
      };
  const a = d.action as
    | {
        success: boolean;
        valid: boolean;
        no_funds: boolean;
        result_code: number;
        tot_actions: number;
        skipped_actions: number;
        msgs_created: number;
        status_change?: string;
      }
    | undefined;
  const bounce = (d.bounce as { type: string } | undefined)?.type;
  return {
    type: 'generic',
    creditFirst: inbound.source !== null && !inbound.bounce,
    computePhase,
    ...(a
      ? {
          actionPhase: {
            success: a.success,
            valid: a.valid,
            noFunds: a.no_funds,
            statusChange: a.status_change === 'deleted' ? 'deleted' : 'unchanged',
            resultCode: a.result_code,
            totalActions: a.tot_actions,
            specActions: 0,
            skippedActions: a.skipped_actions,
            messagesCreated: a.msgs_created,
            actionListHash: 0n,
            totalMessageSize: NO_SIZE,
          },
        }
      : {}),
    ...(bounce === 'ok'
      ? {
          bouncePhase: {
            type: 'ok',
            messageSize: NO_SIZE,
            messageFees: 0n,
            forwardFees: 0n,
          },
        }
      : bounce === 'nofunds'
        ? {
            bouncePhase: {
              type: 'no-funds',
              messageSize: NO_SIZE,
              requiredForwardFees: 0n,
            },
          }
        : bounce === 'negfunds'
          ? { bouncePhase: { type: 'negative-funds' } }
          : {}),
    aborted: d.aborted === true,
    destroyed: d.destroyed === true,
  };
}

/**
 * A transaction's cell as the chain serializes it (block.tlb `transaction$0111`,
 * transaction.cpp `Transaction::serialize`): the account, its lt, the previous
 * transaction's hash and lt, the time, the statuses, the messages, the fees, a state
 * update and the description.
 */
function rawTransaction(
  tx: Pick<
    Tx,
    | 'account'
    | 'now'
    | 'origStatus'
    | 'endStatus'
    | 'inMsg'
    | 'outMsgs'
    | 'totalFees'
    | 'description'
  >,
  lt: bigint,
  prevLt: bigint,
  prevHash: string,
): Cell {
  const outMessages = Dictionary.empty(Dictionary.Keys.Uint(15), MESSAGE_VALUE);
  tx.outMsgs.forEach((m, index) => outMessages.set(index, m.message));
  return beginCell()
    .store(
      storeTransaction({
        address: BigInt(`0x${tx.account.slice(tx.account.indexOf(':') + 1)}`),
        lt,
        prevTransactionHash: BigInt(`0x${prevHash}`),
        prevTransactionLt: prevLt,
        now: tx.now,
        outMessagesCount: tx.outMsgs.length,
        oldStatus: RAW_STATUS[tx.origStatus],
        endStatus: RAW_STATUS[tx.endStatus],
        inMessage: tx.inMsg.message,
        outMessages,
        totalFees: { coins: tx.totalFees },
        stateUpdate: { oldHash: sha(`state:${lt}:old`), newHash: sha(`state:${lt}:new`) },
        description: rawDescription(tx.description, tx.inMsg),
        raw: Cell.EMPTY,
        hash: () => Buffer.alloc(32),
      }),
    )
    .endCell();
}

function msgJson(m: Msg): Record<string, unknown> {
  return {
    hash: b64(Buffer.from(m.hash, 'hex')),
    ...(m.hashNorm ? { hash_norm: b64(Buffer.from(m.hashNorm, 'hex')) } : {}),
    source: m.source === null ? null : upper(m.source),
    destination: upper(m.destination),
    value: m.value === null ? null : m.value.toString(),
    bounce: m.source === null ? null : m.bounce,
    bounced: m.source === null ? null : m.bounced,
    opcode: null,
    message_content: {
      hash: b64(m.body.hash()),
      body: m.body.toBoc().toString('base64'),
      decoded: null,
    },
    init_state: m.initState
      ? { hash: b64(m.initState.hash()), body: m.initState.toBoc().toString('base64') }
      : null,
  };
}

function txJson(t: Tx): Record<string, unknown> {
  return {
    account: upper(t.account),
    hash: b64(Buffer.from(t.hash, 'hex')),
    lt: t.lt.toString(),
    now: t.now,
    mc_block_seqno: t.mcSeqno,
    trace_id: b64(Buffer.from(t.traceId, 'hex')),
    orig_status: t.origStatus,
    end_status: t.endStatus,
    total_fees: t.totalFees.toString(),
    description: t.description,
    in_msg: msgJson(t.inMsg),
    out_msgs: t.outMsgs.map(msgJson),
    emulated: false,
    finality: 'finalized',
  };
}

function hexParam(value: string | null): string {
  if (value === null) return '';
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'hex',
  );
}

/** Accepts raw or friendly addresses as toncenter does; the chain keys are raw. */
function normalizeParam(value: string | null): string {
  if (value === null) return '';
  try {
    return rawOf(Address.parse(value));
  } catch {
    throw new ParamError(`Failed to parse ton_addr: '${value}'`);
  }
}

/** An integer query parameter (a logical time), or null when absent. */
function bigParam(value: string | null): bigint | null {
  if (value === null) return null;
  if (!/^\d{1,20}$/.test(value))
    throw new ParamError(`Failed to parse integer: '${value}'`);
  return BigInt(value);
}

/** The address the master assigns to `owner`'s jetton wallet (the node's own derivation). */
function jettonWalletAddress(master: string, owner: string): string {
  return `0:${sha(`jetton-wallet:${master}:${owner}`).toString('hex')}`;
}

/** An account's v3 status: an uninitialized account without a balance does not exist. */
function v3Status(account: Account | undefined): V3Status {
  if (
    !account ||
    (account.status === 'uninitialized' &&
      account.balance === 0n &&
      !account.extraCurrency)
  ) {
    return 'nonexist';
  }
  return account.status === 'uninitialized' ? 'uninit' : account.status;
}

/**
 * The v3 `action` description of an action phase. It exists only when the compute phase
 * succeeded, and the transaction is aborted unless both succeeded (transaction.cpp).
 */
function actionPhase(actions: Actions, total: number): Record<string, unknown> {
  return actions.ok
    ? {
        success: true,
        valid: true,
        no_funds: false,
        result_code: 0,
        tot_actions: total,
        skipped_actions: actions.skipped,
        msgs_created: actions.out.length,
        ...(actions.destroy ? { status_change: 'deleted' } : {}),
      }
    : {
        // `valid` is set once the list parses, before any message is sent (transaction.cpp).
        success: false,
        valid: true,
        no_funds: actions.resultCode === 37,
        result_code: actions.resultCode,
        tot_actions: total,
        skipped_actions: actions.skipped,
        msgs_created: 0,
      };
}
