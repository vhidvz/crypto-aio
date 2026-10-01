/**
 * A scripted AvalancheGo node for tests (test-only): one chain (the X-Chain's `avm.*` or the
 * P-Chain's `platform.*` JSON-RPC API) and the Avalanche Data API in front of it, served per
 * endpoint through a `FakeFetch`. It models the rules the driver's safety depends on, with
 * AvalancheGo's error texts (`vms/txs/mempool`, `vms/components/avax`,
 * `vms/platformvm/utxo`, `vms/secp256k1fx`):
 * - `issueTx`: the hex checksum; the network and chain; every input an unspent output of the
 *   amount it claims, not spent by a mempool transaction; every credential's signatures
 *   recovering (with `@noble/curves`, never the code under test) to the output's owners at
 *   the input's signer indices; the X-Chain's fixed fee or the P-Chain's gas fee at the
 *   current price; Durango's empty P-Chain memo; 64 KiB. A duplicate of a mempool
 *   transaction is answered with its id, as AvalancheGo does.
 * - `mine()` accepts every mempool transaction into one new block (Snowman: final).
 * - Endpoints may lag (they see the chain as it was `lag` blocks ago) and the indexer may
 *   trail the chain. Deterministic: no timers, no `Math.random`, no `Date.now`.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { base58, bech32 } from '@scure/base';
import { cb58Encode } from '../../../../src/adapters/avalanche/cb58';
import type { AvalancheNetworkConfig } from '../../../../src/adapters/avalanche/network';
import {
  avalanche,
  type SdkSignedTx,
  type SdkTransferOutput,
  type SdkUtxo,
} from '../../../../src/adapters/avalanche/sdk';
import { equalBytes, fromHex, toHex } from '../../../../src/core/util/bytes';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';
import { FAUCET_BYTES, FAUCET_KEY, configOf, type Vm } from './vectors';

const MAX_TX_BYTES = 64 * 1024;
const UTXO_PAGE = 1024;
export const DEFAULT_WEIGHTS: readonly [number, number, number, number] = [
  1, 1000, 1000, 4,
];

export interface ScriptedAvalancheNodeOptions {
  readonly clock: FakeClock;
  readonly vm: Vm;
  readonly network?: 'fuji' | 'mainnet';
  /** X-Chain: the fixed fee (default 1,000,000 nAVAX). */
  readonly txFee?: bigint;
  /** P-Chain: the gas price (default 1) and the fee dimensions' weights. */
  readonly gasPrice?: bigint;
  readonly weights?: readonly [number, number, number, number];
  /** AVAX the faucet holds at genesis. */
  readonly faucet?: bigint;
}

interface Utxo {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly owners: readonly Uint8Array[];
  readonly threshold: number;
  readonly locktime: bigint;
  readonly assetId: string;
  readonly amount: bigint;
}

interface Tx {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly signed: SdkSignedTx;
  readonly inputs: readonly string[];
  readonly outputs: readonly Utxo[];
  readonly signers: readonly Uint8Array[];
}

interface Accepted extends Tx {
  readonly height: number;
  /** A P-Chain proposal transaction whose proposal was aborted: kept, not applied. */
  readonly aborted?: boolean;
}

interface Block {
  readonly id: string;
  readonly parentId: string;
  readonly height: number;
  readonly time: number;
  readonly txIds: readonly string[];
  /** A P-Chain proposal block's proposal transaction (an abort leaves it uncommitted). */
  readonly proposal?: string;
  /** The UTXO set after this block. */
  readonly utxos: ReadonlyMap<string, Utxo>;
}

interface Endpoint {
  lag: number;
}

interface IndexerEndpoint {
  lag: number;
  /** Transactions this indexer pretends not to know. */
  readonly hidden: Set<string>;
}

/**
 * Replaces the node's answer to a JSON-RPC call: `{ result }` or `{ rpcError }` are wrapped
 * in an envelope with the request's id; any other reply is sent as it is; `undefined` lets
 * the node answer.
 */
export type Intercept = (
  method: string,
  params: Record<string, unknown>,
) =>
  | { readonly result: unknown }
  | { readonly rpcError: string; readonly code?: number }
  | FakeReply
  | undefined;

const rpcError = (id: unknown, message: string, code = -32000): FakeReply => ({
  json: { jsonrpc: '2.0', id, error: { code, message, data: null } },
});

const ZERO_ID = '11111111111111111111111111111111LpoYY';

/** `0x…` hex with AvalancheGo's 4-byte SHA-256 checksum. */
export function checked(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes, 0);
  out.set(sha256(bytes).subarray(-4), bytes.length);
  return toHex(out, true);
}

const keyOf = (txId: string, index: number) => `${txId}:${index}`;

export class ScriptedAvalancheNode {
  readonly fetch = new FakeFetch();
  readonly config: AvalancheNetworkConfig;
  readonly vm: Vm;
  /** Hex of every transaction `issueTx` received (accepted or not). */
  readonly issued: string[] = [];
  /** JSON-RPC methods or Data API paths met that this node does not model. */
  readonly unmodelled: string[] = [];
  readonly #clock: FakeClock;
  readonly #endpoints = new Map<string, Endpoint>();
  readonly #indexers = new Map<string, IndexerEndpoint>();
  readonly #intercepts = new Map<string, Intercept>();
  readonly #blocks: Block[] = [];
  readonly #txs = new Map<string, Accepted>();
  readonly #mempool = new Map<string, Tx>();
  readonly #dropped = new Map<string, string>();
  #txFee: bigint;
  #gasPrice: bigint;
  #weights: readonly [number, number, number, number];
  #salt = 0;

  constructor(options: ScriptedAvalancheNodeOptions) {
    this.#clock = options.clock;
    this.vm = options.vm;
    this.config = configOf(options.vm, {}, options.network ?? 'fuji');
    this.#txFee = options.txFee ?? 1_000_000n;
    this.#gasPrice = options.gasPrice ?? 1n;
    this.#weights = options.weights ?? DEFAULT_WEIGHTS;
    // Genesis: block 0 carries the network's identity and funds the faucet, in 16 outputs
    // so that several faucet payments can wait in the mempool together.
    const share = (options.faucet ?? 10n ** 18n) / 16n;
    const faucet = Array.from({ length: 16 }, (_, i) =>
      this.#utxo(ZERO_ID, i, FAUCET_BYTES, share),
    );
    this.#blocks.push({
      id: this.config.genesisBlockId,
      parentId: cb58Encode(new Uint8Array(32).fill(1)),
      height: 0,
      time: Math.floor(this.#clock.now() / 1000),
      txIds: [],
      utxos: new Map(faucet.map((u) => [u.key, u])),
    });
  }

  // ---- scripting ------------------------------------------------------------------------

  get alias(): string {
    return this.config.alias;
  }

  /** A JSON-RPC URL of this chain's API on an endpoint of this node. */
  endpoint(name: string, options: { readonly lag?: number } = {}): string {
    const url = `https://avax-${name}.test/ext/bc/${this.alias}`;
    if (!this.#endpoints.has(name)) {
      this.fetch.route(url, (request) => this.#rpc(name, request));
    }
    this.#endpoints.set(name, { lag: options.lag ?? 0 });
    return url;
  }

  /** A Data API base URL for this chain on an indexer endpoint of this node. */
  indexer(name = 'data', options: { readonly lag?: number } = {}): string {
    const chain = this.vm === 'avm' ? 'x-chain' : 'p-chain';
    const network = this.config.hrp === 'avax' ? 'mainnet' : 'fuji';
    const url = `https://${name}.test/v1/networks/${network}/blockchains/${chain}`;
    if (!this.#indexers.has(name)) {
      this.fetch.route(url, (request) => this.#rest(name, url, request));
      this.#indexers.set(name, { lag: options.lag ?? 0, hidden: new Set() });
    } else {
      (this.#indexers.get(name) as IndexerEndpoint).lag = options.lag ?? 0;
    }
    return url;
  }

  setLag(name: string, lag: number): void {
    const endpoint = this.#endpoints.get(name);
    if (!endpoint) throw new Error(`no endpoint ${name}`);
    endpoint.lag = lag;
  }

  /** The indexer `name` does not know `txId` (it trails, or never indexed it). */
  hideFromIndexer(txId: string, name = 'data'): void {
    this.#indexers.get(name)?.hidden.add(txId);
  }

  intercept(name: string, handler: Intercept): void {
    this.#intercepts.set(name, handler);
  }

  clearIntercept(name: string): void {
    this.#intercepts.delete(name);
  }

  setTxFee(fee: bigint): void {
    this.#txFee = fee;
  }

  setGasPrice(price: bigint): void {
    this.#gasPrice = price;
  }

  get height(): number {
    return this.#blocks.length - 1;
  }

  get mempool(): readonly string[] {
    return [...this.#mempool.keys()];
  }

  isAccepted(txId: string): boolean {
    return this.#txs.has(txId);
  }

  block(height: number): Block | undefined {
    return this.#blocks[height];
  }

  /** The AVAX an address owns in plain, unlocked, threshold-1 outputs. */
  balance(address: Uint8Array): bigint {
    let total = 0n;
    for (const utxo of this.#tip().utxos.values()) {
      if (
        utxo.assetId === this.config.avaxAssetId &&
        utxo.locktime === 0n &&
        utxo.threshold === 1 &&
        utxo.owners.some((o) => equalBytes(o, address))
      ) {
        total += utxo.amount;
      }
    }
    return total;
  }

  utxoKeysOf(address: Uint8Array): string[] {
    return [...this.#tip().utxos.values()]
      .filter((u) => u.owners.some((o) => equalBytes(o, address)))
      .map((u) => u.key);
  }

  /**
   * Pays `amount` from the faucet to `owners` (default threshold 1, no lock) in a signed
   * BaseTx, mined into its own block; resolves to the transaction id.
   */
  fund(
    to: Uint8Array,
    amount: bigint,
    options: {
      readonly locktime?: bigint;
      readonly threshold?: number;
      readonly owners?: readonly Uint8Array[];
      readonly mine?: boolean;
    } = {},
  ): string {
    const tx = this.signedFromFaucet([
      {
        owners: options.owners ?? [to],
        amount,
        locktime: options.locktime ?? 0n,
        threshold: options.threshold ?? 1,
      },
    ]);
    const error = this.#admit(tx);
    if (error) throw new Error(`faucet transaction refused: ${error}`);
    if (options.mine ?? true) this.mine();
    return idOf(tx);
  }

  /** A signed faucet BaseTx paying `outputs` (not issued). */
  signedFromFaucet(
    outputs: readonly {
      readonly owners: readonly Uint8Array[];
      readonly amount: bigint;
      readonly locktime?: bigint;
      readonly threshold?: number;
    }[],
  ): Uint8Array {
    const faucetUtxos = [...this.#tip().utxos.values()]
      .filter(
        (u) =>
          u.owners.some((o) => equalBytes(o, FAUCET_BYTES)) &&
          !this.#spentInMempool(u.key),
      )
      .map((u) => this.#sdkUtxo(u));
    const outs = outputs.map((o) =>
      avalanche.TransferableOutput.fromNative(
        this.config.avaxAssetId,
        o.amount,
        o.owners,
        o.locktime ?? 0n,
        o.threshold ?? 1,
      ),
    );
    const memo = new Uint8Array([this.#salt++ & 0xff]);
    const unsigned =
      this.vm === 'avm'
        ? avalanche.avm.newBaseTx(this.#context(), [FAUCET_BYTES], faucetUtxos, outs, {
            changeAddresses: [FAUCET_BYTES],
            memo,
            minIssuanceTime: BigInt(Math.floor(this.#clock.now() / 1000)),
          })
        : avalanche.pvm.newBaseTx(
            {
              feeState: {
                capacity: 1_000_000n,
                excess: 0n,
                price: this.#gasPrice,
                timestamp: '',
              },
              fromAddressesBytes: [FAUCET_BYTES],
              changeAddressesBytes: [FAUCET_BYTES],
              outputs: outs,
              utxos: faucetUtxos,
              memo: new Uint8Array(),
              minIssuanceTime: BigInt(Math.floor(this.#clock.now() / 1000)),
            },
            this.#context(),
          );
    return signWith(unsigned.toBytes(), FAUCET_KEY, this.vm);
  }

  /** Mints an output of any asset straight into the UTXO set (no transaction). */
  mint(
    to: Uint8Array,
    amount: bigint,
    options: { readonly assetId?: string; readonly locktime?: bigint } = {},
  ): string {
    const txId = cb58Encode(sha256(new TextEncoder().encode(`mint:${this.#salt++}`)));
    const utxo = this.#utxo(txId, 0, to, amount, {
      assetId: options.assetId ?? this.config.avaxAssetId,
      locktime: options.locktime ?? 0n,
    });
    // Minted into the tip's own snapshot: it simply appears in the current UTXO set.
    (this.#tip().utxos as Map<string, Utxo>).set(utxo.key, utxo);
    return utxo.key;
  }

  /**
   * Accepts every mempool transaction into one new block; resolves to its height. With
   * `proposal` (P-Chain), the block also carries a proposal transaction (a faucet payment
   * here) that is committed, or aborted: then it is kept, with its bytes, but not applied.
   */
  mine(options: { readonly proposal?: 'commit' | 'abort' } = {}): number {
    // The proposal is built first, so it spends no output a mempool transaction spends.
    let proposal: Tx | undefined;
    if (options.proposal !== undefined) {
      const bytes = this.signedFromFaucet([{ owners: [FAUCET_BYTES], amount: 1n }]);
      const error = this.#admit(bytes);
      if (error) throw new Error(`proposal refused: ${error}`);
      proposal = this.#mempool.get(idOf(bytes)) as Tx;
      this.#mempool.delete(proposal.id);
    }
    const parent = this.#tip();
    const utxos = new Map(parent.utxos);
    const txIds: string[] = [];
    const height = parent.height + 1;
    const apply = (tx: Tx) => {
      for (const input of tx.inputs) utxos.delete(input);
      for (const output of tx.outputs) utxos.set(output.key, output);
    };
    for (const tx of this.#mempool.values()) {
      apply(tx);
      this.#txs.set(tx.id, { ...tx, height });
      txIds.push(tx.id);
    }
    this.#mempool.clear();
    if (proposal) {
      if (options.proposal === 'commit') apply(proposal);
      this.#txs.set(proposal.id, {
        ...proposal,
        height,
        ...(options.proposal === 'abort' ? { aborted: true } : {}),
      });
      txIds.push(proposal.id);
    }
    const id = cb58Encode(
      sha256(new TextEncoder().encode(`${parent.id}|${height}|${txIds.join(',')}`)),
    );
    this.#blocks.push({
      id,
      parentId: parent.id,
      height,
      time: Math.floor(this.#clock.now() / 1000),
      txIds,
      ...(proposal ? { proposal: proposal.id } : {}),
      utxos,
    });
    return height;
  }

  /** Drops a mempool transaction, as a node does when it fails verification later. */
  drop(txId: string, reason = 'failed verification: insufficient funds'): void {
    this.#mempool.delete(txId);
    this.#dropped.set(txId, reason);
  }

  // ---- model ----------------------------------------------------------------------------

  #tip(): Block {
    return this.#blocks[this.#blocks.length - 1] as Block;
  }

  #visible(lag: number): Block {
    return this.#blocks[Math.max(0, this.#blocks.length - 1 - lag)] as Block;
  }

  #context() {
    return {
      networkID: this.config.networkId,
      hrp: this.config.hrp,
      xBlockchainID: this.vm === 'avm' ? this.config.blockchainId : '',
      pBlockchainID: this.vm === 'pvm' ? this.config.blockchainId : '',
      cBlockchainID: '',
      avaxAssetID: this.config.avaxAssetId,
      baseTxFee: this.#txFee,
      createAssetTxFee: 0n,
      platformFeeConfig: {
        weights: avalanche.Common.createDimensions({
          bandwidth: this.#weights[0],
          dbRead: this.#weights[1],
          dbWrite: this.#weights[2],
          compute: this.#weights[3],
        }),
        maxCapacity: 1_000_000n,
        maxPerSecond: 100_000n,
        targetPerSecond: 50_000n,
        minPrice: 1n,
        excessConversionConstant: 2_164_043n,
      },
    };
  }

  #manager() {
    return avalanche.utils.getManagerForVM(this.vm === 'avm' ? 'AVM' : 'PVM');
  }

  #utxo(
    txId: string,
    index: number,
    owner: Uint8Array,
    amount: bigint,
    options: {
      readonly assetId?: string;
      readonly locktime?: bigint;
      readonly threshold?: number;
      readonly owners?: readonly Uint8Array[];
    } = {},
  ): Utxo {
    const assetId = options.assetId ?? this.config.avaxAssetId;
    const owners = options.owners ?? [owner];
    const out = avalanche.TransferableOutput.fromNative(
      assetId,
      amount,
      owners,
      options.locktime ?? 0n,
      options.threshold ?? 1,
    );
    return this.#utxoOf(txId, index, out);
  }

  #utxoOf(
    txId: string,
    index: number,
    out: ReturnType<typeof avalanche.TransferableOutput.fromNative>,
  ): Utxo {
    const owners = (out.output as SdkTransferOutput).outputOwners;
    const head = new Uint8Array(2 + 32 + 4);
    head.set(fromCb58(txId), 2);
    new DataView(head.buffer).setUint32(34, index);
    // The output as UTXO bytes: the asset id and the type-prefixed output, after the head.
    const body = (out as unknown as { toBytes(codec: unknown): Uint8Array }).toBytes(
      this.#manager().getDefaultCodec(),
    );
    const bytes = new Uint8Array(head.length + body.length);
    bytes.set(head, 0);
    bytes.set(body, head.length);
    return {
      key: keyOf(txId, index),
      bytes,
      owners: owners.addrs.map((a) => a.toBytes()),
      threshold: owners.threshold.value(),
      locktime: owners.locktime.value(),
      assetId: out.assetId.toString(),
      amount: out.amount(),
    };
  }

  #sdkUtxo(utxo: Utxo): SdkUtxo {
    return this.#manager().unpack(utxo.bytes, avalanche.Utxo);
  }

  #spentInMempool(key: string): boolean {
    return [...this.#mempool.values()].some((tx) => tx.inputs.includes(key));
  }

  /** AvalancheGo's verification; returns its error text, or admits `bytes` to the mempool. */
  #admit(bytes: Uint8Array): string | undefined {
    let signed: SdkSignedTx;
    try {
      signed = this.#manager().unpack(bytes, avalanche.avaxSerial.SignedTx);
      if (!equalBytes(signed.toBytes(), bytes)) throw new Error('trailing bytes');
    } catch {
      return this.vm === 'avm'
        ? "couldn't parse tx"
        : "couldn't parse tx: unmarshal error";
    }
    const id = idOf(bytes);
    if (this.#mempool.has(id)) return undefined; // a duplicate: answered with its id
    const verification = (message: string) =>
      this.vm === 'pvm' ? `couldn't issue tx: failed verification: ${message}` : message;
    if (bytes.length > MAX_TX_BYTES) {
      return `${this.vm === 'pvm' ? "couldn't issue tx: " : ''}tx too large: ${id} size (${bytes.length}) > max size (${MAX_TX_BYTES})`;
    }
    const tx = signed.unsignedTx;
    const base = tx.baseTx;
    if (!base) return verification('unsupported tx type');
    if (
      base.NetworkId.value() !== this.config.networkId ||
      base.BlockchainId.toString() !== this.config.blockchainId
    ) {
      return verification('tx has wrong network ID or blockchain ID');
    }
    if (this.vm === 'pvm' && base.memo.bytes.length > 0) {
      return verification(`memo exceeds maximum length: ${base.memo.bytes.length} > 0`);
    }
    const credentials = signed.getCredentials();
    if (credentials.length !== base.inputs.length) {
      return verification('wrong number of credentials');
    }
    const digest = sha256(this.#manager().packCodec(tx));
    const utxos = this.#tip().utxos;
    const inputs: string[] = [];
    const signers: Uint8Array[] = [];
    let consumed = 0n;
    for (const [i, input] of base.inputs.entries()) {
      const key = keyOf(input.utxoID.txID.toString(), input.utxoID.outputIdx.value());
      const utxo = utxos.get(key);
      if (!utxo) {
        return this.vm === 'avm'
          ? `failed to get utxo ${utxoIdOf(key)}: not found`
          : verification(`failed to read consumed UTXO ${key} due to: not found`);
      }
      if (this.#spentInMempool(key)) {
        return `${this.vm === 'pvm' ? "couldn't issue tx: " : ''}tx conflicts with other tx: ${id}`;
      }
      if (utxo.amount !== input.amount()) {
        return verification(
          `utxo amount and input amount are not equal: ${utxo.amount} != ${input.amount()}`,
        );
      }
      if (utxo.locktime > BigInt(Math.floor(this.#clock.now() / 1000))) {
        return verification('output is time locked');
      }
      const indices = input.sigIndicies();
      const sigs = credentials[i]?.getSignatures() ?? [];
      if (indices.length !== sigs.length || indices.length < utxo.threshold) {
        return verification(
          'input expected a different number of signers than provided in the credential',
        );
      }
      for (const [j, index] of indices.entries()) {
        const owner = utxo.owners[index];
        const signer = recover(sigs[j] as string, digest);
        if (!owner || !signer || !equalBytes(owner, signer)) {
          return verification('wrong signature');
        }
        signers.push(signer);
      }
      inputs.push(key);
      if (utxo.assetId === this.config.avaxAssetId) consumed += utxo.amount;
    }
    let produced = 0n;
    const outputs = base.outputs.map((out, index) => {
      if (out.assetId.toString() === this.config.avaxAssetId) produced += out.amount();
      return this.#utxoOf(id, index, out as never);
    });
    const required =
      this.vm === 'avm'
        ? this.#txFee
        : avalanche.pvm.calculateFee(
            tx,
            avalanche.Common.createDimensions({
              bandwidth: this.#weights[0],
              dbRead: this.#weights[1],
              dbWrite: this.#weights[2],
              compute: this.#weights[3],
            }),
            this.#gasPrice,
          );
    if (consumed < produced + required) {
      return this.vm === 'avm'
        ? 'insufficient funds'
        : verification(
            `insufficient unlocked funds: needs ${produced + required - consumed} more ${this.config.avaxAssetId}`,
          );
    }
    this.#mempool.set(id, { id, bytes, signed, inputs, outputs, signers });
    this.#dropped.delete(id);
    return undefined;
  }

  // ---- JSON-RPC -------------------------------------------------------------------------

  #rpc(name: string, request: FakeRequest): FakeReply {
    const body = request.json<{ id?: unknown; method?: string; params?: unknown }>();
    const method = body.method ?? '';
    const params = (body.params ?? {}) as Record<string, unknown>;
    const intercepted = this.#intercepts.get(name)?.(method, params);
    if (intercepted !== undefined) {
      if ('result' in intercepted) {
        return { json: { jsonrpc: '2.0', id: body.id, result: intercepted.result } };
      }
      if ('rpcError' in intercepted) {
        return rpcError(body.id, intercepted.rpcError, intercepted.code);
      }
      return intercepted;
    }
    const prefix = this.vm === 'avm' ? 'avm.' : 'platform.';
    const endpoint = this.#endpoints.get(name) as Endpoint;
    const tip = this.#visible(endpoint.lag);
    const ok = (result: unknown): FakeReply => ({
      json: { jsonrpc: '2.0', id: body.id, result },
    });
    const short = method.startsWith(prefix) ? method.slice(prefix.length) : '';
    switch (short) {
      case 'getHeight':
        return ok({ height: String(tip.height) });
      case 'getBlockByHeight': {
        const height = Number(params.height);
        const block = height <= tip.height ? this.#blocks[height] : undefined;
        return block
          ? ok({ block: this.#blockJson(block), encoding: 'json' })
          : rpcError(body.id, `couldn't get block at height ${params.height}: not found`);
      }
      case 'getBlock': {
        const block = this.#blocks
          .slice(0, tip.height + 1)
          .find((b) => b.id === params.blockID);
        return block
          ? ok({ block: this.#blockJson(block), encoding: 'json' })
          : rpcError(body.id, `couldn't get block with id ${params.blockID}: not found`);
      }
      case 'getTx': {
        const tx = this.#txs.get(String(params.txID));
        if (!tx || tx.height > tip.height) {
          return rpcError(
            body.id,
            this.vm === 'avm' ? 'not found' : "couldn't get tx: not found",
          );
        }
        return ok({ tx: checked(tx.bytes), encoding: 'hex' });
      }
      case 'getTxStatus': {
        if (this.vm === 'avm') break;
        const id = String(params.txID);
        const tx = this.#txs.get(id);
        if (tx && tx.height <= tip.height) {
          return ok({ status: tx.aborted ? 'Aborted' : 'Committed' });
        }
        if (this.#mempool.has(id)) return ok({ status: 'Processing' });
        const reason = this.#dropped.get(id);
        if (reason !== undefined) return ok({ status: 'Dropped', reason });
        return ok({ status: 'Unknown' });
      }
      case 'getUTXOs':
        return this.#getUtxos(body.id, params, tip);
      case 'issueTx': {
        const text = String(params.tx);
        this.issued.push(text);
        let bytes: Uint8Array;
        try {
          const raw = fromHex(text);
          bytes = raw.subarray(0, -4);
          if (!equalBytes(sha256(bytes).subarray(-4), raw.subarray(-4)))
            throw new Error();
        } catch {
          return rpcError(
            body.id,
            'problem decoding transaction: invalid input checksum',
          );
        }
        const error = this.#admit(bytes);
        return error ? rpcError(body.id, error) : ok({ txID: idOf(bytes) });
      }
      case 'getTxFee':
        if (this.vm !== 'avm') break;
        return ok({ txFee: String(this.#txFee), createAssetTxFee: '10000000' });
      case 'getFeeState':
        if (this.vm !== 'pvm') break;
        return ok({
          capacity: 1_000_000,
          excess: 0,
          price: Number(this.#gasPrice),
          timestamp: new Date(this.#clock.now()).toISOString(),
        });
      case 'getFeeConfig':
        if (this.vm !== 'pvm') break;
        return ok({
          weights: [...this.#weights],
          maxCapacity: 1_000_000,
          maxPerSecond: 100_000,
          targetPerSecond: 50_000,
          minPrice: 1,
          excessConversionConstant: 2_164_043,
        });
      default:
        break;
    }
    this.unmodelled.push(method);
    return rpcError(
      body.id,
      `the method ${method} does not exist/is not available`,
      -32601,
    );
  }

  #blockJson(block: Block): Record<string, unknown> {
    const tx = (id: string) => ({ unsignedTx: {}, credentials: [], id });
    const decisions = block.proposal
      ? block.txIds.filter((id) => id !== block.proposal)
      : block.txIds;
    return {
      parentID: block.parentId,
      height: block.height,
      time: block.time,
      ...(this.vm === 'avm' ? { merkleRoot: ZERO_ID } : {}),
      txs: decisions.map(tx),
      ...(block.proposal ? { tx: tx(block.proposal) } : {}),
      id: block.id,
    };
  }

  #getUtxos(id: unknown, params: Record<string, unknown>, tip: Block): FakeReply {
    const addresses = params.addresses as string[];
    const address = addresses[0] ?? '';
    const bech = address.slice(address.indexOf('-') + 1);
    let owner: Uint8Array;
    try {
      owner = bech32Bytes(bech);
    } catch {
      return rpcError(id, "couldn't parse address");
    }
    if (!address.startsWith(`${this.alias}-`)) {
      return rpcError(id, "couldn't parse address: wrong chain alias");
    }
    const limit = Math.min(Number(params.limit ?? UTXO_PAGE), UTXO_PAGE);
    const all = [...tip.utxos.values()]
      .filter((u) => u.owners.some((o) => equalBytes(o, owner)))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const start = params.startIndex as { utxo?: string } | undefined;
    const from = start?.utxo
      ? all.findIndex((u) => utxoIdOf(u.key) === start.utxo) + 1
      : 0;
    const page = all.slice(from, from + limit);
    const last = page.at(-1);
    return {
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          numFetched: String(page.length),
          utxos: page.map((u) => checked(u.bytes)),
          endIndex: { address, utxo: last ? utxoIdOf(last.key) : '' },
          encoding: 'hex',
        },
      },
    };
  }

  // ---- Data API -------------------------------------------------------------------------

  #rest(name: string, base: string, request: FakeRequest): FakeReply {
    const indexer = this.#indexers.get(name) as IndexerEndpoint;
    const tip = this.#visible(indexer.lag);
    const path = request.url.href.slice(base.length).split('?')[0] ?? '';
    const notFound: FakeReply = {
      status: 404,
      json: { message: 'Not Found', statusCode: 404 },
    };
    if (path === '/blocks/0') {
      return { json: { blockNumber: '0', blockHash: this.config.genesisBlockId } };
    }
    if (path === '/blocks') {
      return {
        json: { blocks: [{ blockNumber: String(tip.height), blockHash: tip.id }] },
      };
    }
    const one = /^\/transactions\/([1-9A-HJ-NP-Za-km-z]+)$/.exec(path);
    if (one) {
      const txId = one[1] as string;
      const tx = this.#txs.get(txId);
      if (!tx || tx.height > tip.height || indexer.hidden.has(txId)) return notFound;
      return { json: this.#indexed(tx) };
    }
    if (path === '/transactions') {
      const address = request.url.searchParams.get('addresses') ?? '';
      const bech = address.slice(address.indexOf('-') + 1);
      const owner = bech32Bytes(bech);
      const pageSize = Number(request.url.searchParams.get('pageSize') ?? '10');
      const offset = Number(request.url.searchParams.get('pageToken') ?? '0');
      const touching = [...this.#txs.values()]
        .filter(
          (tx) =>
            tx.height <= tip.height &&
            !indexer.hidden.has(tx.id) &&
            (tx.outputs.some((o) => o.owners.some((x) => equalBytes(x, owner))) ||
              tx.signers.some((s) => equalBytes(s, owner))),
        )
        .sort((a, b) => b.height - a.height);
      const page = touching.slice(offset, offset + pageSize);
      const more = offset + pageSize < touching.length;
      return {
        json: {
          transactions: page.map((tx) => this.#indexed(tx)),
          ...(more ? { nextPageToken: String(offset + pageSize) } : {}),
          chainInfo: { chainName: this.vm === 'avm' ? 'x-chain' : 'p-chain' },
        },
      };
    }
    this.unmodelled.push(path);
    return notFound;
  }

  #indexed(tx: Accepted): Record<string, unknown> {
    const block = this.#blocks[tx.height] as Block;
    return this.vm === 'avm'
      ? {
          txHash: tx.id,
          chainFormat: 'linear',
          blockHash: block.id,
          blockHeight: block.height,
        }
      : { txHash: tx.id, blockNumber: String(block.height), blockHash: block.id };
  }
}

function fromCb58(text: string): Uint8Array {
  return base58.decode(text).subarray(0, -4);
}

function bech32Bytes(text: string): Uint8Array {
  return bech32.fromWords(bech32.decode(text as `${string}1${string}`).words);
}

/** The UTXO id AvalancheGo pages by (sha256 of the index and the tx id), CB58. */
function utxoIdOf(key: string): string {
  const [txId, index] = key.split(':') as [string, string];
  const bytes = new Uint8Array(8 + 32);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(index));
  bytes.set(fromCb58(txId), 8);
  return cb58Encode(sha256(bytes));
}

export function idOf(bytes: Uint8Array): string {
  return cb58Encode(sha256(bytes));
}

/** The address a hex signature over `digest` recovers to. */
function recover(hex: string, digest: Uint8Array): Uint8Array | undefined {
  const sig = fromHex(hex.replace(/^0x/, ''));
  if (sig.length !== 65) return undefined;
  try {
    const signature = secp256k1.Signature.fromCompact(sig.subarray(0, 64));
    if (signature.hasHighS()) return undefined; // AvalancheGo: errMutatedSig
    const point = signature.addRecoveryBit(sig[64] as number).recoverPublicKey(digest);
    return ripemd160(sha256(point.toRawBytes(true)));
  } catch {
    return undefined;
  }
}

/** Signs unsigned bytes with `key` the way wallets do: one signature in every credential. */
export function signWith(unsignedBytes: Uint8Array, key: Uint8Array, vm: Vm): Uint8Array {
  const manager = avalanche.utils.getManagerForVM(vm === 'avm' ? 'AVM' : 'PVM');
  const tx = manager.unpackTransaction(unsignedBytes);
  const sig = secp256k1.sign(sha256(unsignedBytes), key, { lowS: true });
  const bytes = new Uint8Array(65);
  bytes.set(sig.toCompactRawBytes(), 0);
  bytes[64] = sig.recovery;
  const credentials = tx
    .getSigIndices()
    .map((ix) => new avalanche.Credential(ix.map(() => new avalanche.Signature(bytes))));
  return new avalanche.avaxSerial.SignedTx(tx, credentials).toBytes();
}
