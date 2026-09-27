/**
 * A scripted toncenter node for offline tests (test-only, D19): API v2 (a liteserver proxy)
 * and API v3 (an indexer) over one simulated chain. It exists to test safety invariants, so
 * it models the rules the driver relies on (lesson 8), each from the contract or node source:
 * - wallets v4r2 and v5r1: signature over the signing cell hash (front / tail), wallet id,
 *   seqno, `valid_until <= now` refusal, deployment by `StateInit`, seqno committed before
 *   the actions, and send mode +2 skipping a message the balance cannot pay; a v5r1
 *   `internal_signed` request relayed in an internal message, ignored when its signature
 *   fails (wallet_v5.fc);
 * - external messages the chain cannot accept are refused at send time (HTTP 500, as
 *   toncenter) and, when state changed meanwhile, silently never included;
 * - internal messages delivered one masterchain block later, bounce for bounceable
 *   messages to an uninitialized account or a failing contract, TEP-74 jettons with
 *   notifications, excesses and bounced `internal_transfer`s;
 * - one masterchain block per `mine()`, one or two basechain shards (`shards`), each
 *   `shardLagSeconds` (the second `secondShardLagSeconds`) older than its masterchain block;
 * - state snapshots per masterchain block for `seqno=` reads;
 * - an indexer that trails the chain by `indexerLag` blocks, and traces that complete only
 *   when every message of the trace has been delivered and indexed.
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
  storeMessageRelaxed,
  type MessageRelaxed,
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

/** Shard ids (signed 64-bit, as toncenter v2 writes them) for one or two basechain shards. */
const SHARDS = ['-9223372036854775808', '-4611686018427387904'];

/** Config param 25 (basechain message prices), as on mainnet (Plan 6 appendix). */
export const MSG_PRICES_BOC =
  'te6cckEBAQEAIwAAQuoAAAAAAAEEawAAAAAAQqqrAAAAABoKqqsAAYAAVVVVVXUQ/H0=';
/** Config param 24 (masterchain message prices), as on mainnet. */
export const MC_MSG_PRICES_BOC =
  'te6cckEBAQEAIwAAQuoAAAAAAJiWgAAAAAAnEAAAAAAAD0JAAAAAAYAAVVVVVX2jQy8=';
const PRICES = configParseMsgPrices(
  (Cell.fromBoc(Buffer.from(MSG_PRICES_BOC, 'base64'))[0] as Cell).beginParse(),
);

/** Fixed fees of the simulated chain, nanograms. */
export const NODE_FEES = Object.freeze({
  importFee: 1_000_000n,
  gasV4: 2_000_000n,
  gasV5: 2_500_000n,
  deployGas: 500_000n,
  internalGas: 300_000n,
  jettonGas: 10_000_000n,
});

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
  readonly init?: boolean;
}

interface Tx {
  readonly hash: string;
  readonly lt: bigint;
  readonly account: string;
  readonly now: number;
  readonly mcSeqno: number;
  readonly traceId: string;
  readonly totalFees: bigint;
  readonly description: Record<string, unknown>;
  readonly inMsg: Msg;
  readonly outMsgs: readonly Msg[];
}

interface Queued {
  readonly msg: Msg;
  readonly traceId: string;
  readonly readyAt: number;
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

export type Intercept = (
  endpoint: string,
  route: string,
  request: FakeRequest,
) => FakeReply | undefined;

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

  /** The v2 (`rpc`) or v3 (`indexer`) base URL of a named endpoint. */
  endpoint(name: string, api: 'v2' | 'v3'): string {
    const base = `https://${name}.ton.test/api/${api}`;
    this.fetch.route(base, (request) => this.#serve(name, api, request));
    return base;
  }

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

  fund(address: string, nanograms: bigint): void {
    const account = this.#account(address);
    account.balance += nanograms;
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
    const account = this.#account(address);
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
    this.#account(address).balance -= nanograms;
    this.#sealState();
  }

  /** Freezes an account (storage debt), as the chain does to an account it cannot charge. */
  freeze(address: string): void {
    this.#account(address).status = 'frozen';
    this.#sealState();
  }

  /** A contract that fails every inbound message (bounceable ones bounce). */
  deployReverter(address: string): void {
    const account = this.#account(address);
    account.status = 'active';
    account.reverter = true;
    this.#sealState();
  }

  deployJetton(master: string, jetton: Jetton): void {
    const account = this.#account(master);
    account.status = 'active';
    account.jetton = jetton;
    this.#sealState();
  }

  /** The jetton wallet the master assigns to `owner`. */
  jettonWalletOf(master: string, owner: string): string {
    const address = `0:${sha(`jetton-wallet:${master}:${owner}`).toString('hex')}`;
    this.#owners.set(address, owner);
    return address;
  }

  readonly #owners = new Map<string, string>();

  /** A contract at `address` that claims to be `owner`'s jetton wallet of `master`. */
  deployFakeJettonWallet(
    address: string,
    master: string,
    owner: string,
    balance: bigint,
  ): void {
    const account = this.#account(address);
    account.status = 'active';
    account.jettonWallet = { master, owner, balance };
    this.#sealState();
  }

  mintJetton(master: string, owner: string, amount: bigint): void {
    const address = this.jettonWalletOf(master, owner);
    const account = this.#account(address);
    account.status = 'active';
    account.jettonWallet = account.jettonWallet ?? { master, owner, balance: 0n };
    account.jettonWallet.balance += amount;
    this.#sealState();
  }

  jettonBalance(master: string, owner: string): bigint {
    return (
      this.#accounts.get(this.jettonWalletOf(master, owner))?.jettonWallet?.balance ?? 0n
    );
  }

  balance(address: string): bigint {
    return this.#accounts.get(address)?.balance ?? 0n;
  }

  status(address: string): Account['status'] {
    return this.#accounts.get(address)?.status ?? 'uninitialized';
  }

  seqno(address: string): number {
    return this.#accounts.get(address)?.wallet?.seqno ?? 0;
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

  /** Queues an internal message from any account, delivered with the next block. */
  inject(
    source: string,
    destination: string,
    value: bigint,
    body: Cell,
    bounce = false,
  ): void {
    const traceId = this.#hashOf('tx');
    this.#queue.push({
      msg: this.#internal(source, destination, value, bounce, body),
      traceId,
      readyAt: this.head + 1,
    });
  }

  /** Accepts an external message as `/sendBocReturnHash` does; throws the node's text. */
  submit(boc: string): { readonly hash: string; readonly hashNorm: string } {
    const cell = Cell.fromBoc(Buffer.from(boc, 'base64'))[0] as Cell;
    const message = loadMessage(cell.beginParse());
    if (message.info.type !== 'external-in') throw new Error('Failed to unpack Message');
    const dest = rawOf(message.info.dest);
    const hashNorm = normalizedHash(cell);
    const verdict = this.#checkExternal(
      dest,
      message.init ?? undefined,
      message.body,
      this.#now(),
    );
    if (verdict !== 'ok') {
      throw new Error(
        `LITE_SERVER_UNKNOWN: cannot apply external message to current state : External message was not accepted\n${verdict}`,
      );
    }
    this.#sends.set(hashNorm, (this.#sends.get(hashNorm) ?? 0) + 1);
    const hash = cell.hash().toString('hex');
    if (!this.swallow && !this.#pending.some((p) => p.hash === hash)) {
      this.#pending.push({ boc, cell, hash });
    }
    return { hash, hashNorm };
  }

  /** Produces `count` masterchain blocks (each with one shard block). */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) this.#mineOne();
  }

  // ---- chain rules ----------------------------------------------------------------------

  #now(): number {
    return Math.floor(this.#clock.now() / 1000) - this.shardLagSeconds;
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

  /** The wallet contract's checks, in its order; 'ok' or the node's error text. */
  #checkExternal(
    dest: string,
    init: { code?: Cell | null; data?: Cell | null } | undefined,
    body: Cell,
    now: number,
  ): string {
    const account = this.#accounts.get(dest);
    const wallet =
      account?.status === 'active' ? account.wallet : this.#walletFromInit(dest, init);
    if (!wallet)
      return 'Cannot run message on account: no state (account is not initialized)';
    const request = parseRequest(wallet.version, body);
    if (!request) return 'exitcode=9, steps=1';
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
    for (const [passed, code] of checks) if (!passed) return `exitcode=${code}`;
    const gas = this.#walletGas(wallet.version, account?.status !== 'active');
    if ((account?.balance ?? 0n) < NODE_FEES.importFee + gas) {
      return 'Cannot run message on account: not enough balance to pay for gas';
    }
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
    const now = this.#now();
    // Internal messages created in earlier blocks are delivered first.
    const ready = this.#queue.filter((q) => q.readyAt <= seqno);
    for (const item of ready) this.#queue.splice(this.#queue.indexOf(item), 1);
    for (const item of ready) this.#deliver(item, seqno, now);
    const pending = this.#pending.splice(0);
    for (const item of pending) this.#processExternal(item.cell, seqno, now);
    this.#seal();
  }

  #hashOf(kind: string): string {
    this.#counter += 1;
    return sha(`${kind}:${this.#counter}`).toString('hex');
  }

  #record(tx: Omit<Tx, 'hash' | 'lt'>, hash = this.#hashOf('tx')): Tx {
    this.#lt += 1000n;
    const full: Tx = { ...tx, hash, lt: this.#lt };
    const account = this.#account(tx.account);
    account.lastLt = full.lt;
    account.lastHash = full.hash;
    this.#txs.push(full);
    return full;
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
    return {
      hash: this.#hashOf('msg'),
      source,
      destination,
      value,
      bounce,
      bounced,
      body,
    };
  }

  #processExternal(cell: Cell, seqno: number, now: number): void {
    const message = loadMessage(cell.beginParse());
    if (message.info.type !== 'external-in') return;
    const dest = rawOf(message.info.dest);
    // Re-checked against the state at inclusion: a message that no longer applies is
    // never included and leaves no trace (it may still be retried until it expires).
    if (this.#checkExternal(dest, message.init ?? undefined, message.body, now) !== 'ok')
      return;
    const account = this.#account(dest);
    const deploy = account.status !== 'active';
    const wallet = deploy
      ? (this.#walletFromInit(dest, message.init ?? undefined) as Wallet)
      : (account.wallet as Wallet);
    const request = parseRequest(wallet.version, message.body) as Request;
    const fees = NODE_FEES.importFee + this.#walletGas(wallet.version, deploy);
    account.balance -= fees;
    account.status = 'active';
    account.wallet = { ...wallet, seqno: wallet.seqno + 1 };
    if (request.withoutIgnoreErrors) {
      // wallet_v5.fc: `commit()` keeps the seqno, then error 137 aborts the transaction.
      this.#record({
        account: dest,
        now,
        mcSeqno: seqno,
        traceId: this.#hashOf('trace'),
        totalFees: fees,
        description: {
          type: 'ord',
          aborted: true,
          compute_ph: { skipped: false, success: false, exit_code: 137 },
        },
        inMsg: {
          hash: cell.hash().toString('hex'),
          source: null,
          destination: dest,
          value: null,
          bounce: false,
          bounced: false,
          body: message.body,
          hashNorm: normalizedHash(cell),
          init: deploy,
        },
        outMsgs: [],
      });
      return;
    }
    let forwardFees = 0n;
    let skipped = 0;
    const out: Msg[] = [];
    // The trace is named after its root transaction, as toncenter's `trace_id`.
    const traceId = this.#hashOf('tx');
    for (const requested of request.messages) {
      if (requested.info.type !== 'internal') continue;
      const fwd = forwardFee(requested);
      const value = requested.info.value.coins;
      if (account.balance < value + fwd) {
        skipped += 1;
        continue;
      }
      account.balance -= value + fwd;
      forwardFees += fwd;
      out.push(
        this.#internal(
          dest,
          rawOf(requested.info.dest),
          value,
          requested.info.bounce,
          requested.body,
        ),
      );
    }
    const inMsg: Msg = {
      hash: cell.hash().toString('hex'),
      source: null,
      destination: dest,
      value: null,
      bounce: false,
      bounced: false,
      body: message.body,
      hashNorm: normalizedHash(cell),
      init: deploy,
    };
    const tx = this.#record(
      {
        account: dest,
        now,
        mcSeqno: seqno,
        traceId,
        totalFees: fees + forwardFees,
        description: {
          type: 'ord',
          aborted: false,
          compute_ph: { skipped: false, success: true, exit_code: 0 },
          action: {
            success: true,
            valid: true,
            result_code: 0,
            tot_actions: request.messages.length,
            skipped_actions: skipped,
            msgs_created: out.length,
          },
        },
        inMsg,
        outMsgs: out,
      },
      traceId,
    );
    for (const msg of out) this.#send(msg, tx.traceId, seqno);
  }

  #deliver(item: Queued, seqno: number, now: number): void {
    const { msg, traceId } = item;
    const account = this.#account(msg.destination);
    const value = msg.value ?? 0n;
    const out: Msg[] = [];
    let aborted = false;
    let compute: Record<string, unknown> = {
      skipped: false,
      success: true,
      exit_code: 0,
    };
    let bounce: Record<string, unknown> | undefined;
    const fail = (exitCode: number, skipReason?: string): void => {
      aborted = true;
      compute = skipReason
        ? { skipped: true, reason: skipReason }
        : { skipped: false, success: false, exit_code: exitCode };
      if (msg.bounce && !msg.bounced) {
        bounce = { type: 'ok' };
        account.balance -= value;
        const back = value - NODE_FEES.internalGas;
        if (back > 0n) {
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
        }
      }
    };
    account.balance += value;
    const op = opOf(msg.body);
    if (msg.bounced) {
      // A bounced internal_transfer returns its amount to the sending jetton wallet.
      if (account.jettonWallet && bouncedOp(msg.body) === OP.internalTransfer) {
        account.jettonWallet.balance += bouncedAmount(msg.body);
      }
    } else if (account.status !== 'active' && op !== OP.internalTransfer) {
      fail(0, 'no_state');
    } else if (op === OP.signedInternal && account.wallet?.version === 'v5r1') {
      // wallet_v5.fc `recv_internal`: a relayed signed request. A failing signature is
      // ignored (the transaction succeeds and changes nothing); otherwise the seqno, wallet
      // id and lifetime are checked (133, 134, 136), the seqno committed, the actions run.
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
          wallet.seqno += 1;
          for (const requested of request.messages) {
            if (requested.info.type !== 'internal') continue;
            const sent = requested.info.value.coins;
            const fwd = forwardFee(requested);
            if (account.balance < sent + fwd) continue; // send mode +2: skipped
            account.balance -= sent + fwd;
            out.push(
              this.#internal(
                msg.destination,
                rawOf(requested.info.dest),
                sent,
                requested.info.bounce,
                requested.body,
              ),
            );
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
          .storeAddress(Address.parseRaw(t.response))
          .storeCoins(t.forwardAmount)
          .storeSlice(t.forwardPayload)
          .endCell();
        out.push(
          this.#internal(msg.destination, to, value - NODE_FEES.internalGas, true, body),
        );
      }
    } else if (op === OP.internalTransfer) {
      const t = parseInternalTransfer(msg.body);
      if (!t || this.#failing.has(msg.destination)) {
        if (account.status !== 'active') account.status = 'active';
        fail(this.#failing.has(msg.destination) ? 709 : 9);
      } else {
        const master = this.#jettonMasterOf(msg.source as string);
        account.status = 'active';
        account.jettonWallet = account.jettonWallet ?? {
          master,
          owner: this.#ownerFor(msg.destination),
          balance: 0n,
        };
        account.jettonWallet.balance += t.amount;
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
            this.#internal(
              msg.destination,
              account.jettonWallet.owner,
              t.forwardAmount,
              false,
              note,
            ),
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
    this.#record({
      account: msg.destination,
      now,
      mcSeqno: seqno,
      traceId,
      totalFees: NODE_FEES.internalGas,
      description: {
        type: 'ord',
        aborted,
        compute_ph: compute,
        ...(aborted
          ? {}
          : {
              action: {
                success: true,
                valid: true,
                result_code: 0,
                skipped_actions: 0,
                msgs_created: out.length,
                tot_actions: out.length,
              },
            }),
        ...(bounce ? { bounce } : {}),
      },
      inMsg: msg,
      outMsgs: out,
    });
    for (const next of out) this.#send(next, traceId, seqno);
  }

  readonly #failing = new Set<string>();

  /** Makes the jetton wallet at `address` fail every `internal_transfer` (it bounces). */
  failJettonWallet(address: string): void {
    this.#failing.add(address);
  }

  #jettonMasterOf(senderJettonWallet: string): string {
    return (
      this.#accounts.get(senderJettonWallet)?.jettonWallet?.master ??
      '0:' + '0'.repeat(64)
    );
  }

  #ownerFor(jettonWallet: string): string {
    return this.#owners.get(jettonWallet) ?? `0:${'0'.repeat(64)}`;
  }

  #seal(): void {
    const seqno = this.#blocks.length === 0 ? 1 : this.head + 1;
    const genUtime = Math.floor(this.#clock.now() / 1000);
    this.#blocks.push({
      seqno,
      genUtime,
      rootHash: sha(`mc-root:${seqno}`).toString('hex'),
      fileHash: sha(`mc-file:${seqno}`).toString('hex'),
      shards: SHARDS.slice(0, this.shardCount).map((shard, index) => ({
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

  #serve(name: string, api: 'v2' | 'v3', request: FakeRequest): FakeReply {
    const route = request.url.pathname.replace(/^\/api\/v[23]/, '');
    this.served.push({ endpoint: name, route });
    const intercepted = this.intercept?.(name, route, request);
    if (intercepted) return intercepted;
    try {
      return api === 'v2' ? this.#v2(name, route, request) : this.#v3(route, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 500, json: { ok: false, error: message, code: 500 } };
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
    const mcId = (b: Block) => ({
      '@type': 'ton.blockIdExt',
      workchain: -1,
      shard: '-9223372036854775808',
      seqno: b.seqno,
      root_hash: b64(Buffer.from(b.rootHash, 'hex')),
      file_hash: b64(Buffer.from(b.fileHash, 'hex')),
    });
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
        const index = SHARDS.indexOf(q.get('shard') ?? '');
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
        const body = request.json<{ address: string; body: string; init_code: string }>();
        const deploy = body.init_code !== '';
        const account = this.#accounts.get(normalizeParam(body.address));
        const version = deploy
          ? Cell.fromBoc(Buffer.from(body.init_code, 'base64'))[0]
              ?.hash()
              .equals(WALLET_CODE.v4r2.hash())
            ? 'v4r2'
            : 'v5r1'
          : (account?.wallet?.version ?? 'v4r2');
        // The real action list's forward fees, as a liteserver's emulation reports them.
        const request_ = parseRequest(
          version,
          Cell.fromBoc(Buffer.from(body.body, 'base64'))[0] as Cell,
        );
        const fwd = (request_?.messages ?? []).reduce(
          (sum, m) => sum + forwardFee(m),
          0n,
        );
        return ok({
          '@type': 'query.fees',
          source_fees: {
            '@type': 'fees',
            in_fwd_fee: Number(NODE_FEES.importFee),
            storage_fee: 0,
            gas_fee: Number(this.#walletGas(version, deploy)),
            fwd_fee: Number(fwd),
          },
          destination_fees: [],
        });
      }
      case '/sendBocReturnHash': {
        const { boc } = request.json<{ boc: string }>();
        const sent = this.submit(boc);
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
    const result = (exitCode: number, entries: unknown[]) => ({
      '@type': 'smc.runResult',
      gas_used: 100,
      stack: entries,
      exit_code: exitCode,
      block_id: {},
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
        const endLt = q.get('end_lt');
        const limit = Number(q.get('limit') ?? '10');
        const list = indexed
          .filter(
            (t) => t.account === account && (endLt === null || t.lt <= BigInt(endLt)),
          )
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
        const root = members.find((t) => t.hash === tx.traceId) ?? members[0];
        return {
          json: {
            traces: [
              {
                trace_id: b64(Buffer.from((root as Tx).hash, 'hex')),
                external_hash: b64(Buffer.from((root as Tx).inMsg.hash, 'hex')),
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
        const jetton = this.#accounts.get(address)?.jetton;
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
        const jetton = this.#accounts.get(address)?.jetton;
        return {
          json: jetton?.symbol
            ? {
                [upper(address)]: {
                  is_indexed: true,
                  token_info: [
                    { valid: true, type: 'jetton_masters', symbol: jetton.symbol },
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
  readonly messages: readonly MessageRelaxed[];
  /** W5: an action without send mode +2; the wallet commits the seqno, then throws 137. */
  readonly withoutIgnoreErrors?: boolean;
}

/** The wallet contract's own parse (v4r2: signature first; v5r1: last). */
/** A wallet request's parts; `op` is the v5r1 prefix (external or relayed internally). */
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
      const messages: MessageRelaxed[] = [];
      while (s.remainingRefs > 0) {
        s.loadUint(8);
        messages.push(loadMessageRelaxed(s.loadRef().beginParse()));
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
    const messages: MessageRelaxed[] = [];
    for (const action of list ? loadOutList(list.beginParse()) : []) {
      if (action.type === 'sendMsg') {
        if ((action.mode & 2) === 0) withoutIgnoreErrors = true;
        messages.push(action.outMsg);
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

function forwardFee(message: MessageRelaxed): bigint {
  const cell = beginCell().store(storeMessageRelaxed(message)).endCell();
  const { fees, remaining } = computeMessageForwardFees(PRICES, cell);
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
    const response = rawOf(s.loadAddress());
    s.loadMaybeRef();
    const forwardAmount = s.loadCoins();
    return { queryId, amount, destination, response, forwardAmount, forwardPayload: s };
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
    init_state: null,
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
    orig_status: 'active',
    end_status: 'active',
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
  return rawOf(Address.parse(value));
}
