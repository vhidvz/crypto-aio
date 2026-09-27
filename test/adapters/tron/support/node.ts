/**
 * A scripted Tron node for tests (test-only, D6): java-tron's HTTP API (`/wallet`,
 * `/walletsolidity`), its JSON-RPC block reads and TronGrid's `/v1` history, served per
 * endpoint through a `FakeFetch`. It models the rules the driver's safety depends on
 * (lesson 8), as verified in java-tron's source (Plan 4 appendix):
 * - admission: signature size, duplicate, TaPoS (ref block in the canonical chain),
 *   expiration (> head time and ≤ head time + 24 h), size, signature owner, contract
 *   validation, bandwidth (staked, then free, then burned; new accounts: staked × rate or
 *   the creation fee, plus 1 TRX), the memo fee, and the fee limit ceiling;
 * - execution in blocks: a transaction is valid in a block only while its expiration is
 *   after the parent's timestamp; TRC-20 energy is capped at min(staked + balance / price,
 *   fee_limit / price), so a low fee limit is included and fails `OUT_OF_ENERGY`;
 * - 3-second slots, solidification `solidDepth` blocks below the head, reorgs of
 *   unsolidified blocks only, and endpoints that lag.
 * It decodes transactions with the independent test protobuf codec and recovers signers
 * with `@noble/curves`, never with the code under test. Deterministic: no timers, no
 * `Math.random`, no `Date.now`.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import {
  addressFromPublicKey,
  toHexAddress,
} from '../../../../src/adapters/tron/address';
import type { TronRawData } from '../../../../src/adapters/tron/types';
import { fromHex, toHex, utf8ToBytes } from '../../../../src/core/util/bytes';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';
import { decodeRawData, decodeTransaction } from './protobuf';

export const GENESIS: Readonly<Record<string, string>> = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  shasta: '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e',
  nile: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
};

export const PARAMS = {
  getTransactionFee: 1_000n,
  getEnergyFee: 100n,
  getCreateAccountFee: 100_000n,
  getCreateNewAccountFeeInSystemContract: 1_000_000n,
  getCreateNewAccountBandwidthRate: 1n,
  getMemoFee: 1_000_000n,
  getMaxFeeLimit: 15_000_000_000n,
  getFreeNetLimit: 600n,
};

/** Energy of a TRC-20 transfer to an existing holder, and the extra for a new holder slot. */
export const TRANSFER_ENERGY = 14_650n;
export const NEW_HOLDER_ENERGY = 15_000n;
const MAX_EXPIRATION_MS = 86_400_000;
const MAX_TX_BYTES = 512_000;

export interface NodeOptions {
  readonly clock: FakeClock;
  /** Which genesis id block 0 carries (default nile). */
  readonly network?: string;
  /** Blocks between the head and the latest solidified block (default 19). */
  readonly solidDepth?: number;
  readonly params?: Partial<typeof PARAMS>;
}

interface Account {
  balance: bigint;
  freeNetUsed: bigint;
  stakedNet: bigint;
  netUsed: bigint;
  stakedEnergy: bigint;
  energyUsed: bigint;
}

export type TokenMode = 'standard' | 'no-log' | 'reverting-metadata' | 'fee';

interface Token {
  readonly symbol: string;
  readonly decimals: number;
  readonly mode: TokenMode;
  readonly balances: Map<string, bigint>;
}

interface State {
  readonly accounts: Map<string, Account>;
  readonly tokens: Map<string, Token>;
}

interface Receipt {
  readonly contractRet: 'SUCCESS' | 'REVERT' | 'OUT_OF_ENERGY';
  readonly fee: bigint;
  readonly netUsage: bigint;
  readonly netFee: bigint;
  readonly energyUsage: bigint;
  readonly energyFee: bigint;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}

export interface StoredTx {
  readonly id: string;
  readonly rawHex: string;
  readonly raw: TronRawData;
  readonly signature: string;
  readonly bytes: bigint;
  receipt?: Receipt;
  blockNumber?: number;
}

interface Block {
  readonly number: number;
  readonly id: string;
  readonly parentId: string;
  readonly timestamp: number;
  readonly txs: StoredTx[];
  readonly state: State;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const cloneState = (state: State): State => ({
  accounts: new Map([...state.accounts].map(([k, v]) => [k, { ...v }])),
  tokens: new Map(
    [...state.tokens].map(([k, v]) => [k, { ...v, balances: new Map(v.balances) }]),
  ),
});

const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const hexOf = (text: string): string => toHex(utf8ToBytes(text));
const omitZero = (key: string, value: bigint): Record<string, bigint> =>
  value === 0n ? {} : { [key]: value };

/** JSON with exact integers, as java-tron writes them: a bigint is a bare number literal. */
function exactJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `#bigint:${v}#` : v,
  ).replace(/"#bigint:(-?\d+)#"/g, '$1');
}

/** A fee-on-transfer token's collector (mode 'fee'). */
export const FEE_COLLECTOR = '41' + 'fe'.repeat(20);

export class ScriptedTronNode {
  readonly fetch = new FakeFetch();
  readonly params: typeof PARAMS;
  readonly #clock: FakeClock;
  readonly #solidDepth: number;
  readonly #blocks: Block[] = [];
  readonly #pool: StoredTx[] = [];
  readonly #lag = new Map<string, number>();
  readonly #timestampLies = new Map<string, number>();
  readonly #intercepts: {
    endpoint: string;
    path: string;
    handler: (request: FakeRequest) => FakeReply | undefined;
  }[] = [];
  #salt = 0;
  /** Percent of the base energy a TRC-20 transfer costs (dynamic energy), default 100. */
  energyFactor = 100n;

  constructor(options: NodeOptions) {
    this.#clock = options.clock;
    this.#solidDepth = options.solidDepth ?? 19;
    this.params = { ...PARAMS, ...options.params };
    const genesis = GENESIS[options.network ?? 'nile'] as string;
    this.#blocks.push({
      number: 0,
      id: genesis,
      parentId: '0'.repeat(64),
      timestamp: Math.floor(this.#clock.now() / 3000) * 3000 - 3000,
      txs: [],
      state: { accounts: new Map(), tokens: new Map() },
    });
  }

  // ---- scripting -----------------------------------------------------------------------

  endpoint(name: string): string {
    const url = `https://${name}.tron.test`;
    this.fetch.route(`${url}/`, (request) => this.#serve(name, request));
    return url;
  }

  get head(): number {
    return this.#last.number;
  }

  get solid(): number {
    return Math.max(0, this.head - this.#solidDepth);
  }

  get #last(): Block {
    return this.#blocks[this.#blocks.length - 1] as Block;
  }

  /** A mutable view of the head state for setup (changes apply to later blocks). */
  #account(address: string): Account {
    const hex = toHexAddress(address);
    const accounts = this.#last.state.accounts;
    let account = accounts.get(hex);
    if (!account) {
      account = {
        balance: 0n,
        freeNetUsed: 0n,
        stakedNet: 0n,
        netUsed: 0n,
        stakedEnergy: 0n,
        energyUsed: 0n,
      };
      accounts.set(hex, account);
    }
    return account;
  }

  /** Like a TRX transfer to `address`: it activates the account, so `sun` must be positive. */
  fund(address: string, sun: bigint): void {
    if (sun <= 0n) throw new Error('fund needs a positive amount');
    this.#account(address).balance += sun;
  }

  stake(address: string, resources: { bandwidth?: bigint; energy?: bigint }): void {
    const account = this.#account(address);
    account.stakedNet += resources.bandwidth ?? 0n;
    account.stakedEnergy += resources.energy ?? 0n;
  }

  balance(address: string): bigint {
    return this.#last.state.accounts.get(toHexAddress(address))?.balance ?? 0n;
  }

  exists(address: string): boolean {
    return this.#last.state.accounts.has(toHexAddress(address));
  }

  deployToken(
    address: string,
    token: { symbol: string; decimals: number; mode?: TokenMode },
  ): void {
    this.#last.state.tokens.set(toHexAddress(address), {
      symbol: token.symbol,
      decimals: token.decimals,
      mode: token.mode ?? 'standard',
      balances: new Map(),
    });
  }

  mintToken(token: string, holder: string, amount: bigint): void {
    const state = this.#last.state.tokens.get(toHexAddress(token));
    if (!state) throw new Error('no such token');
    const key = toHexAddress(holder);
    state.balances.set(key, (state.balances.get(key) ?? 0n) + amount);
  }

  tokenBalance(token: string, holder: string): bigint {
    return (
      this.#last.state.tokens
        .get(toHexAddress(token))
        ?.balances.get(toHexAddress(holder)) ?? 0n
    );
  }

  /** Make `endpoint`'s JSON-RPC blocks report timestamps `ms` earlier (a lying endpoint). */
  lieAboutTimestamps(endpoint: string, ms: number): void {
    this.#timestampLies.set(endpoint, ms);
  }

  /** Serve `endpoint`'s views `blocks` blocks behind the head (0 clears it). */
  lag(endpoint: string, blocks: number): void {
    this.#lag.set(endpoint, blocks);
  }

  /** Answer `path` on `endpoint` with `handler` while it returns a reply. */
  intercept(
    endpoint: string,
    path: string,
    handler: (request: FakeRequest) => FakeReply | undefined,
  ): void {
    this.#intercepts.push({ endpoint, path, handler });
  }

  inPool(id: string): boolean {
    return this.#pool.some((tx) => tx.id === id);
  }

  transaction(id: string): StoredTx | undefined {
    for (const block of this.#blocks) {
      const tx = block.txs.find((t) => t.id === id);
      if (tx) return tx;
    }
    return undefined;
  }

  block(number: number): { id: string; timestamp: number } | undefined {
    const block = this.#blocks[number];
    return block ? { id: block.id, timestamp: block.timestamp } : undefined;
  }

  /**
   * Mines one block at the next slot (at least one slot after the parent, and not before
   * the clock's slot). Pending transactions that are valid against the parent are
   * executed in arrival order; expired or orphaned ones leave the pool.
   */
  mine(options: { readonly include?: boolean } = {}): number {
    const parent = this.#last;
    const timestamp = Math.max(
      parent.timestamp + 3000,
      Math.floor(this.#clock.now() / 3000) * 3000,
    );
    let state = cloneState(parent.state);
    const txs: StoredTx[] = [];
    const keep: StoredTx[] = [];
    for (const tx of this.#pool.splice(0)) {
      if (options.include === false) {
        // java-tron drops what can no longer be valid in the next block.
        if (tx.raw.expiration > timestamp) keep.push(tx);
        continue;
      }
      try {
        this.#checkCommon(tx, parent, true);
        const applied = this.#tryApply(state, tx);
        state = applied.state;
        tx.receipt = applied.receipt;
        tx.blockNumber = parent.number + 1;
        txs.push(tx);
      } catch {
        // Invalid in this block (expired, orphaned reference, now unaffordable): dropped.
      }
    }
    this.#pool.push(...keep);
    const number = parent.number + 1;
    const id = this.#blockId(number, parent.id, timestamp, txs);
    this.#blocks.push({ number, id, parentId: parent.id, timestamp, txs, state });
    return number;
  }

  /**
   * Replaces the last `depth` blocks (never a solidified one) with empty blocks at the same
   * heights and slots but other ids; their transactions go back to the pool.
   */
  reorg(depth: number): void {
    if (depth < 1 || this.head - depth < this.solid) throw new Error('reorg too deep');
    const removed = this.#blocks.splice(this.#blocks.length - depth, depth);
    const returned = removed.flatMap((b) => b.txs);
    for (const tx of returned) {
      delete tx.receipt;
      delete tx.blockNumber;
    }
    this.#pool.unshift(...returned);
    for (const old of removed) {
      const parent = this.#last;
      this.#salt += 1;
      const id = this.#blockId(old.number, parent.id, old.timestamp, []);
      this.#blocks.push({
        number: old.number,
        id,
        parentId: parent.id,
        timestamp: old.timestamp,
        txs: [],
        state: cloneState(parent.state),
      });
    }
  }

  #blockId(number: number, parentId: string, timestamp: number, txs: StoredTx[]): string {
    const digest = toHex(
      sha256(
        utf8ToBytes(
          `${parentId}:${timestamp}:${this.#salt}:${txs.map((t) => t.id).join(',')}`,
        ),
      ),
    );
    return number.toString(16).padStart(16, '0') + digest.slice(16);
  }

  // ---- rules ---------------------------------------------------------------------------

  /**
   * TaPoS and expiration against `parent` (java-tron `validateTapos`, `validateCommon`). In a
   * block, java-tron with `getConsensusLogicOptimization` = 1 (mainnet) also refuses an
   * expiration before the next slot (`TransactionCapsule.checkExpiration`).
   */
  #checkCommon(tx: StoredTx, parent: Block, inBlock: boolean): void {
    const refNumber = this.#blocks
      .slice(0, parent.number + 1)
      .filter(
        (b) =>
          b.number.toString(16).padStart(16, '0').slice(12, 16) === tx.raw.refBlockBytes,
      );
    if (!refNumber.some((b) => b.id.slice(16, 32) === tx.raw.refBlockHash)) {
      throw new Refusal('TAPOS_ERROR', 'Tapos check error.');
    }
    if (tx.bytes > BigInt(MAX_TX_BYTES)) {
      throw new Refusal(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction, TxId ${tx.id}, the size is ${tx.bytes} bytes, maxTxSize ${MAX_TX_BYTES}`,
      );
    }
    if (
      tx.raw.expiration <= parent.timestamp ||
      tx.raw.expiration > parent.timestamp + MAX_EXPIRATION_MS
    ) {
      throw new Refusal('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired');
    }
    if (inBlock && tx.raw.expiration < parent.timestamp + 3000) {
      throw new Refusal('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired');
    }
  }

  #bandwidth(
    owner: Account,
    tx: StoredTx,
    creates: boolean,
  ): {
    fee: bigint;
    usage: bigint;
  } {
    const bytes = tx.bytes;
    if (creates) {
      const cost = bytes * this.params.getCreateNewAccountBandwidthRate;
      if (owner.stakedNet - owner.netUsed >= cost) {
        owner.netUsed += cost;
        return { fee: 0n, usage: cost };
      }
      if (owner.balance < this.params.getCreateAccountFee) {
        throw new Refusal('BANDWITH_ERROR', 'Account resource insufficient error.');
      }
      owner.balance -= this.params.getCreateAccountFee;
      return { fee: this.params.getCreateAccountFee, usage: 0n };
    }
    if (owner.stakedNet - owner.netUsed >= bytes) {
      owner.netUsed += bytes;
      return { fee: 0n, usage: bytes };
    }
    if (this.params.getFreeNetLimit - owner.freeNetUsed >= bytes) {
      owner.freeNetUsed += bytes;
      return { fee: 0n, usage: bytes };
    }
    const fee = bytes * this.params.getTransactionFee;
    if (owner.balance < fee) {
      throw new Refusal('BANDWITH_ERROR', 'Account resource insufficient error.');
    }
    owner.balance -= fee;
    return { fee, usage: 0n };
  }

  /**
   * `#apply` on a copy of `state`: the new state and the receipt, or a `Refusal` with
   * `state` untouched. java-tron runs each transaction in its own revoking session, so a
   * refused one leaves nothing behind (not even the bandwidth it had counted).
   */
  #tryApply(
    state: State,
    tx: StoredTx,
  ): { readonly state: State; readonly receipt: Receipt } {
    const next = cloneState(state);
    return { state: next, receipt: this.#apply(next, tx) };
  }

  /** Validates and executes `tx` on `state` (mutating it); throws a `Refusal` when invalid. */
  #apply(state: State, tx: StoredTx): Receipt {
    const { contract } = tx.raw;
    const owner = state.accounts.get(contract.owner);
    const signer = this.#signer(tx);
    if (signer !== contract.owner) {
      throw new Refusal('SIGERROR', `Validate signature error: ${tx.id} sig error`);
    }
    if (contract.type === 'TransferContract') {
      if (contract.to === contract.owner) {
        throw new Refusal(
          'CONTRACT_VALIDATE_ERROR',
          'Contract validate error : Cannot transfer TRX to yourself.',
        );
      }
      if (!owner) {
        throw new Refusal(
          'CONTRACT_VALIDATE_ERROR',
          'Contract validate error : Validate TransferContract error, no OwnerAccount.',
        );
      }
      if (contract.amount <= 0n) {
        throw new Refusal(
          'CONTRACT_VALIDATE_ERROR',
          'Contract validate error : Amount must be greater than 0.',
        );
      }
      const creates = !state.accounts.has(contract.to);
      const net = this.#bandwidth(owner, tx, creates);
      const systemFee = creates ? this.params.getCreateNewAccountFeeInSystemContract : 0n;
      const memoFee = tx.raw.data !== undefined ? this.params.getMemoFee : 0n;
      if (owner.balance < contract.amount + systemFee + memoFee) {
        throw new Refusal(
          'CONTRACT_VALIDATE_ERROR',
          'Contract validate error : Validate TransferContract error, balance is not sufficient.',
        );
      }
      owner.balance -= contract.amount + systemFee + memoFee;
      const to = state.accounts.get(contract.to) ?? {
        balance: 0n,
        freeNetUsed: 0n,
        stakedNet: 0n,
        netUsed: 0n,
        stakedEnergy: 0n,
        energyUsed: 0n,
      };
      to.balance += contract.amount;
      state.accounts.set(contract.to, to);
      return {
        contractRet: 'SUCCESS',
        fee: net.fee + systemFee + memoFee,
        netUsage: net.usage,
        netFee: net.fee,
        energyUsage: 0n,
        energyFee: 0n,
        logs: [],
      };
    }
    if (!owner) {
      throw new Refusal(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : No contract or not a valid smart contract',
      );
    }
    const feeLimit = BigInt(tx.raw.feeLimit ?? 0);
    if (feeLimit > this.params.getMaxFeeLimit) {
      throw new Refusal(
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : feeLimit must be >= 0 and <= ${this.params.getMaxFeeLimit}`,
      );
    }
    const token = state.tokens.get(contract.contract);
    if (!token) {
      throw new Refusal(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : No contract or not a valid smart contract',
      );
    }
    const net = this.#bandwidth(owner, tx, false);
    const memoFee = tx.raw.data !== undefined ? this.params.getMemoFee : 0n;
    if (owner.balance < memoFee) {
      throw new Refusal('BANDWITH_ERROR', 'Account resource insufficient error.');
    }
    owner.balance -= memoFee;
    const price = this.params.getEnergyFee;
    const call = this.#tokenCall(contract.contract, token, contract.owner, contract.data);
    const available = owner.stakedEnergy - owner.energyUsed + owner.balance / price;
    const limit = [available, feeLimit / price].reduce((a, b) => (a < b ? a : b));
    const needed = call.energy;
    const used = needed <= limit ? needed : limit;
    const fromStake = [used, owner.stakedEnergy - owner.energyUsed].reduce((a, b) =>
      a < b ? a : b,
    );
    const burned = (used - fromStake) * price;
    owner.energyUsed += fromStake;
    owner.balance -= burned;
    const base = {
      fee: net.fee + memoFee + burned,
      netUsage: net.usage,
      netFee: net.fee,
    };
    if (needed > limit) {
      return {
        ...base,
        contractRet: 'OUT_OF_ENERGY',
        energyUsage: fromStake,
        energyFee: burned,
        logs: [],
      };
    }
    if (call.revert) {
      return {
        ...base,
        contractRet: 'REVERT',
        energyUsage: fromStake,
        energyFee: burned,
        logs: [],
      };
    }
    call.commit?.();
    return {
      ...base,
      contractRet: 'SUCCESS',
      energyUsage: fromStake,
      energyFee: burned,
      logs: call.logs,
    };
  }

  /** A TRC-20 call on `token` from `caller`: its result, energy, logs and state change. */
  #tokenCall(
    address: string,
    token: Token,
    caller: string,
    data: string,
  ): {
    readonly result: string;
    readonly energy: bigint;
    readonly revert: boolean;
    readonly logs: { address: string; topics: string[]; data: string }[];
    readonly commit?: () => void;
  } {
    const selector = data.slice(0, 8);
    const arg = (i: number) => data.slice(8 + i * 64, 8 + (i + 1) * 64);
    const holder = (w: string) => `41${w.slice(24)}`;
    if (selector === '70a08231' && data.length === 72) {
      return {
        result: word(token.balances.get(holder(arg(0))) ?? 0n),
        energy: 4_000n,
        revert: false,
        logs: [],
      };
    }
    if (selector === '313ce567' && data.length === 8) {
      if (token.mode === 'reverting-metadata')
        return { result: '', energy: 300n, revert: true, logs: [] };
      return {
        result: word(BigInt(token.decimals)),
        energy: 300n,
        revert: false,
        logs: [],
      };
    }
    if (selector === '95d89b41' && data.length === 8) {
      if (token.mode === 'reverting-metadata')
        return { result: '', energy: 300n, revert: true, logs: [] };
      const bytes = hexOf(token.symbol);
      return {
        result: word(32n) + word(BigInt(bytes.length / 2)) + bytes.padEnd(64, '0'),
        energy: 600n,
        revert: false,
        logs: [],
      };
    }
    if (selector === 'a9059cbb' && data.length === 136) {
      const to = holder(arg(0));
      const amount = BigInt(`0x${arg(1)}`);
      const balance = token.balances.get(caller) ?? 0n;
      const fresh = (token.balances.get(to) ?? 0n) === 0n;
      const energy =
        ((TRANSFER_ENERGY + (fresh ? NEW_HOLDER_ENERGY : 0n)) * this.energyFactor) / 100n;
      if (balance < amount) return { result: '', energy: 1_000n, revert: true, logs: [] };
      const topic = toHex(keccak_256(utf8ToBytes('Transfer(address,address,uint256)')));
      const log = (to_: string, value: bigint) => ({
        address: address.slice(2),
        topics: [
          topic,
          caller.slice(2).padStart(64, '0'),
          to_.slice(2).padStart(64, '0'),
        ],
        data: word(value),
      });
      if (token.mode === 'fee' && amount > 1n) {
        // A fee of 1 base unit: the recipient gets amount - 1, the collector 1.
        return {
          result: word(1n),
          energy,
          revert: false,
          logs: [log(to, amount - 1n), log(FEE_COLLECTOR, 1n)],
          commit: () => {
            token.balances.set(caller, balance - amount);
            token.balances.set(to, (token.balances.get(to) ?? 0n) + amount - 1n);
            token.balances.set(
              FEE_COLLECTOR,
              (token.balances.get(FEE_COLLECTOR) ?? 0n) + 1n,
            );
          },
        };
      }
      return {
        result: word(token.mode === 'no-log' ? 0n : 1n),
        energy,
        revert: false,
        logs:
          token.mode === 'no-log'
            ? []
            : [
                {
                  address: address.slice(2),
                  topics: [
                    toHex(keccak_256(utf8ToBytes('Transfer(address,address,uint256)'))),
                    caller.slice(2).padStart(64, '0'),
                    to.slice(2).padStart(64, '0'),
                  ],
                  data: word(amount),
                },
              ],
        commit: () => {
          if (token.mode === 'no-log') return;
          token.balances.set(caller, balance - amount);
          token.balances.set(to, (token.balances.get(to) ?? 0n) + amount);
        },
      };
    }
    return { result: '', energy: 500n, revert: true, logs: [] };
  }

  #signer(tx: StoredTx): string {
    const sig = fromHex(tx.signature);
    if (sig.length !== 65) return '';
    const v = sig[64] as number;
    const recovery = v >= 27 ? v - 27 : v;
    try {
      const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
        .addRecoveryBit(recovery)
        .recoverPublicKey(fromHex(tx.id));
      return toHexAddress(addressFromPublicKey(point.toRawBytes(true)));
    } catch {
      return '';
    }
  }

  #admit(hex: string): { txid: string; transaction: string } {
    let decoded: { rawHex: string; signatures: readonly string[] };
    let raw: TronRawData;
    try {
      decoded = decodeTransaction(hex);
      raw = decodeRawData(decoded.rawHex);
    } catch {
      throw new Refusal(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : No contract!',
      );
    }
    const id = toHex(sha256(fromHex(decoded.rawHex)));
    for (const s of decoded.signatures) {
      if (fromHex(s).length !== 65) {
        throw new Refusal(
          'SIGERROR',
          `Validate signature error: Signature size is ${fromHex(s).length}`,
        );
      }
    }
    if (this.inPool(id) || this.transaction(id)) {
      throw new Refusal('DUP_TRANSACTION_ERROR', 'Dup transaction.');
    }
    const tx: StoredTx = {
      id,
      rawHex: decoded.rawHex,
      raw,
      signature: decoded.signatures[0] ?? '',
      // java-tron's bandwidth: the signed size without `ret`, plus 64 result bytes.
      bytes: BigInt(fromHex(hex).length + 64),
    };
    const head = this.#last;
    this.#checkCommon(tx, head, false);
    let pending = head.state;
    for (const earlier of this.#pool) {
      try {
        pending = this.#tryApply(pending, earlier).state;
      } catch {
        // Pool entries that no longer apply are dropped at mining.
      }
    }
    this.#tryApply(pending, tx);
    this.#pool.push(tx);
    // java-tron also echoes the transaction as a JSON string (tronweb parses it).
    return {
      txid: id,
      transaction: JSON.stringify({ txID: id, raw_data_hex: tx.rawHex }),
    };
  }

  // ---- HTTP ----------------------------------------------------------------------------

  #view(endpoint: string): { head: number; solid: number } {
    const head = Math.max(0, this.head - (this.#lag.get(endpoint) ?? 0));
    return { head, solid: Math.max(0, head - this.#solidDepth) };
  }

  #header(block: Block): Record<string, unknown> {
    return {
      blockID: block.id,
      block_header: {
        raw_data: {
          number: block.number,
          txTrieRoot:
            block.txs.length === 0
              ? '0'.repeat(64)
              : toHex(sha256(utf8ToBytes(block.id))),
          witness_address: '41' + 'ab'.repeat(20),
          parentHash: block.parentId,
          version: 32,
          timestamp: block.timestamp,
        },
        witness_signature: 'ff'.repeat(65),
      },
    };
  }

  #txJson(tx: StoredTx): Record<string, unknown> {
    const c = tx.raw.contract;
    return {
      ...(tx.receipt ? { ret: [{ contractRet: tx.receipt.contractRet }] } : {}),
      signature: [tx.signature],
      txID: tx.id,
      raw_data: {
        contract: [
          c.type === 'TransferContract'
            ? {
                parameter: {
                  value: {
                    amount: c.amount,
                    owner_address: c.owner,
                    to_address: c.to,
                  },
                  type_url: 'type.googleapis.com/protocol.TransferContract',
                },
                type: 'TransferContract',
              }
            : {
                parameter: {
                  value: {
                    data: c.data,
                    owner_address: c.owner,
                    contract_address: c.contract,
                  },
                  type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
                },
                type: 'TriggerSmartContract',
              },
        ],
        ref_block_bytes: tx.raw.refBlockBytes,
        ref_block_hash: tx.raw.refBlockHash,
        expiration: tx.raw.expiration,
        ...(tx.raw.data !== undefined ? { data: tx.raw.data } : {}),
        ...(tx.raw.feeLimit !== undefined ? { fee_limit: tx.raw.feeLimit } : {}),
        timestamp: tx.raw.timestamp,
      },
      raw_data_hex: tx.rawHex,
    };
  }

  #infoJson(tx: StoredTx): Record<string, unknown> {
    const r = tx.receipt as Receipt;
    const block = this.#blocks[tx.blockNumber as number] as Block;
    const trigger = tx.raw.contract.type === 'TriggerSmartContract';
    return {
      id: tx.id,
      ...omitZero('fee', r.fee),
      blockNumber: block.number,
      blockTimeStamp: block.timestamp,
      contractResult: [''],
      ...(trigger
        ? { contract_address: (tx.raw.contract as { contract: string }).contract }
        : {}),
      receipt: {
        ...omitZero('energy_usage', r.energyUsage),
        ...omitZero('energy_fee', r.energyFee),
        ...omitZero(
          'energy_usage_total',
          r.energyUsage + r.energyFee / this.params.getEnergyFee,
        ),
        ...omitZero('net_usage', r.netUsage),
        ...omitZero('net_fee', r.netFee),
        ...(trigger ? { result: r.contractRet } : {}),
      },
      ...(r.logs.length > 0 ? { log: r.logs } : {}),
      ...(r.contractRet !== 'SUCCESS'
        ? {
            result: 'FAILED',
            resMessage: hexOf(
              r.contractRet === 'REVERT' ? 'REVERT opcode executed' : 'Not enough energy',
            ),
          }
        : {}),
    };
  }

  #findBlock(idOrNum: unknown, limit: number): Block | undefined {
    if (typeof idOrNum === 'string' && /^[0-9a-f]{64}$/.test(idOrNum)) {
      const block = this.#blocks.find((b) => b.id === idOrNum);
      return block && block.number <= limit ? block : undefined;
    }
    const n = typeof idOrNum === 'number' ? idOrNum : Number(idOrNum);
    return Number.isSafeInteger(n) && n >= 0 && n <= limit ? this.#blocks[n] : undefined;
  }

  /** Every JSON answer is written with exact integers, as java-tron does (A12). */
  #serve(endpoint: string, request: FakeRequest): FakeReply {
    const reply = this.#answer(endpoint, request);
    if (reply instanceof Response || !('json' in reply) || reply.json === undefined) {
      return reply;
    }
    const { json, ...rest } = reply;
    return {
      ...rest,
      text: exactJson(json),
      headers: { 'content-type': 'application/json', ...rest.headers },
    };
  }

  #answer(endpoint: string, request: FakeRequest): FakeReply {
    const path = request.url.pathname;
    for (const i of this.#intercepts) {
      if (i.endpoint === endpoint && i.path === path) {
        const reply = i.handler(request);
        if (reply) return reply;
      }
    }
    const view = this.#view(endpoint);
    const body =
      request.method === 'POST' ? (request.json<Record<string, unknown>>() ?? {}) : {};
    const solidity = path.startsWith('/walletsolidity/');
    const limit = solidity ? view.solid : view.head;
    const visible = (tx: StoredTx | undefined) =>
      tx && tx.blockNumber !== undefined && tx.blockNumber <= limit ? tx : undefined;
    const name = path.replace(/^\/wallet(solidity)?\//, '');
    if (path === '/jsonrpc') return this.#jsonRpc(request, view.head, endpoint);
    if (path.startsWith('/v1/accounts/')) return this.#history(request, view.solid);
    switch (name) {
      case 'getblock': {
        const block =
          body.id_or_num === undefined
            ? this.#blocks[limit]
            : this.#findBlock(body.id_or_num, limit);
        if (!block) return { json: {} };
        return {
          json: {
            ...this.#header(block),
            ...(body.detail === true && block.txs.length > 0
              ? { transactions: block.txs.map((t) => this.#txJson(t)) }
              : {}),
          },
        };
      }
      case 'getblockbynum': {
        const block = this.#findBlock(body.num, limit);
        return { json: block ? this.#header(block) : {} };
      }
      case 'getchainparameters':
        return {
          json: {
            chainParameter: [
              ...Object.entries(this.params).map(([key, value]) => ({
                key,
                ...(value === 0n ? {} : { value: Number(value) }),
              })),
              // As on Nile: a parameter with a negative value the driver never reads.
              { key: 'getRemoveThePowerOfTheGr', value: -1 },
            ],
          },
        };
      case 'getaccount': {
        const account = this.#blocks[view.head]?.state.accounts.get(String(body.address));
        if (!account) return { json: {} };
        return {
          json: {
            address: body.address,
            ...omitZero('balance', account.balance),
            create_time: 1,
          },
        };
      }
      case 'getaccountresource': {
        const account = this.#blocks[view.head]?.state.accounts.get(String(body.address));
        if (!account) return { json: {} };
        return {
          json: {
            freeNetLimit: Number(this.params.getFreeNetLimit),
            ...omitZero('freeNetUsed', account.freeNetUsed),
            ...omitZero('NetLimit', account.stakedNet),
            ...omitZero('NetUsed', account.netUsed),
            ...omitZero('EnergyLimit', account.stakedEnergy),
            ...omitZero('EnergyUsed', account.energyUsed),
            TotalNetLimit: 43_200_000_000,
            TotalEnergyLimit: 180_000_000_000,
          },
        };
      }
      case 'triggerconstantcontract': {
        const token = this.#blocks[view.head]?.state.tokens.get(
          String(body.contract_address),
        );
        if (!token) {
          return {
            json: {
              result: {
                code: 'CONTRACT_VALIDATE_ERROR',
                message: hexOf('Smart contract is not exist.'),
              },
            },
          };
        }
        const call = this.#tokenCall(
          String(body.contract_address),
          token,
          String(body.owner_address),
          String(body.data ?? ''),
        );
        return {
          json: {
            constant_result: [call.result],
            result: {
              result: true,
              ...(call.revert ? { message: hexOf('REVERT opcode executed') } : {}),
            },
            energy_used: Number(call.energy),
            transaction: {
              ret: [call.revert ? { ret: 'FAILED' } : {}],
              txID: '00'.repeat(32),
            },
          },
        };
      }
      case 'broadcasthex': {
        try {
          return { json: { result: true, ...this.#admit(String(body.transaction)) } };
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          return { json: { result: false, code: error.code, message: error.message } };
        }
      }
      case 'gettransactionbyid': {
        const tx = visible(this.transaction(String(body.value)));
        return { json: tx ? this.#txJson(tx) : {} };
      }
      case 'gettransactioninfobyid': {
        const tx = visible(this.transaction(String(body.value)));
        return { json: tx ? this.#infoJson(tx) : {} };
      }
      case 'gettransactionfrompending': {
        const tx = this.#pool.find((t) => t.id === body.value);
        return { json: tx && view.head === this.head ? this.#txJson(tx) : {} };
      }
      case 'gettransactioninfobyblocknum': {
        const block = this.#findBlock(body.num, limit);
        return { json: block ? block.txs.map((t) => this.#infoJson(t)) : [] };
      }
      default:
        return { status: 404, text: 'Not Found' };
    }
  }

  #jsonRpc(request: FakeRequest, head: number, endpoint: string): FakeReply {
    const skew = this.#timestampLies.get(endpoint) ?? 0;
    const { id, method, params } = request.json<{
      id: unknown;
      method: string;
      params: unknown[];
    }>();
    const reply = (result: unknown) => ({ json: { jsonrpc: '2.0', id, result } });
    const shape = (block: Block | undefined) =>
      block
        ? {
            number: `0x${block.number.toString(16)}`,
            hash: `0x${block.id}`,
            parentHash: `0x${block.parentId}`,
            timestamp: `0x${((block.timestamp - skew) / 1000).toString(16)}`,
            transactions: block.txs.map((t) => `0x${t.id}`),
          }
        : null;
    if (method === 'eth_getBlockByHash') {
      const hash = String(params[0]).replace(/^0x/, '');
      return reply(shape(this.#findBlock(hash, head)));
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = String(params[0]);
      const n =
        tag === 'latest'
          ? head
          : tag === 'finalized'
            ? Math.max(0, head - this.#solidDepth)
            : Number(BigInt(tag));
      return reply(shape(this.#findBlock(n, head)));
    }
    return {
      json: { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } },
    };
  }

  /** TronGrid `/v1/accounts/:address/transactions[/trc20]`, confirmed (solidified) only. */
  #history(request: FakeRequest, solid: number): FakeReply {
    const [, , , address, , kind] = request.url.pathname.split('/');
    const hex = toHexAddress(String(address));
    const limit = Number(request.url.searchParams.get('limit') ?? '20');
    const start = Number(request.url.searchParams.get('fingerprint') ?? '0');
    const txs = this.#blocks
      .slice(1, solid + 1)
      .reverse()
      .flatMap((b) => [...b.txs].reverse());
    const trc20 = kind === 'trc20';
    const related = txs.filter((t) => {
      const c = t.raw.contract;
      if (!trc20)
        return c.owner === hex || (c.type === 'TransferContract' && c.to === hex);
      return (t.receipt?.logs ?? []).some(
        (l) => l.topics[1]?.endsWith(hex.slice(2)) || l.topics[2]?.endsWith(hex.slice(2)),
      );
    });
    const page = related.slice(start, start + limit);
    const next = start + limit < related.length ? String(start + limit) : undefined;
    const data = page.map((t) => {
      const block = this.#blocks[t.blockNumber as number] as Block;
      if (!trc20)
        return {
          ...this.#txJson(t),
          blockNumber: block.number,
          block_timestamp: block.timestamp,
        };
      return { transaction_id: t.id, block_timestamp: block.timestamp, type: 'Transfer' };
    });
    return {
      json: {
        data,
        success: true,
        meta: {
          at: this.#clock.now(),
          page_size: data.length,
          ...(next ? { fingerprint: next } : {}),
        },
      },
    };
  }
}
