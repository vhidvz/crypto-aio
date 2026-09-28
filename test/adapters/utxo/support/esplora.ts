/**
 * The Esplora REST layer of the scripted node (test-only): what one endpoint shows (its view
 * of the chain and the mempool, I1) and electrs' routes and answer shapes over that view.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bitcoin, type Network } from '../../../../src/adapters/utxo/sdk';
import { concatBytes, equalBytes, fromHex, toHex } from '../../../../src/core/util/bytes';
import type { FakeReply } from '../../../../src/testing/fake-fetch';
import type { Block, EndpointOptions, Entry, ErrorFormat, Output, State } from './node';
import { compactSizeLength, solve, type ScriptType } from './script';

/** electrs' page size for block transactions and address history. */
const PAGE = 25;
const outpointOf = (txid: string, vout: number): string => `${txid}:${vout}`;
const reversedHex = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

/** What one endpoint shows: blocks up to `height` and the mempool it holds. */
export interface View {
  readonly height: number;
  readonly lightMode: boolean;
  readonly pooled: ReadonlyMap<string, Entry>;
  readonly spentBy: ReadonlyMap<string, string>;
}

/** electrs' REST API over the node's state, as one endpoint serves it. */
export class EsploraApi {
  /** Views are derived from an immutable state: cached per state object. */
  readonly #views = new WeakMap<State, Map<string, View>>();

  constructor(
    readonly network: Network,
    readonly variant: ErrorFormat,
  ) {}

  /** The answer to a GET of `parts`, or `undefined` for a route electrs does not have. */
  get(
    state: State,
    endpoint: Required<EndpointOptions>,
    now: number,
    parts: readonly string[],
    estimates: Readonly<Record<string, number>>,
  ): FakeReply | undefined {
    const view = this.#view(state, endpoint, now);
    const [head, a, b] = parts;
    const n = parts.length;
    switch (head) {
      case 'blocks':
        if (n === 3 && a === 'tip' && b === 'height')
          return { text: String(view.height) };
        if (n === 3 && a === 'tip' && b === 'hash') {
          return { text: (state.chain[view.height] as Block).hash };
        }
        return undefined;
      case 'block-height': {
        if (n !== 2) return undefined;
        const height = parseNumber(a as string, Number.MAX_SAFE_INTEGER);
        if (height === undefined) return { status: 400, text: 'Invalid number' };
        const block = height <= view.height ? state.chain[height] : undefined;
        return block ? { text: block.hash } : { status: 404, text: 'Block not found' };
      }
      case 'block':
        return this.#blockRoute(state, view, parts);
      case 'tx':
        return this.#txRoute(state, view, parts);
      case 'address':
        return this.#addressRoute(state, view, parts);
      case 'fee-estimates':
        return n === 1 ? { json: estimates } : undefined;
      default:
        return undefined;
    }
  }

  /**
   * What an endpoint shows: blocks up to its view, and a mempool of the transactions it
   * saw relayed (the node's, after `mempoolDelayMs`, plus those of blocks above its view
   * that were in a mempool first, or that such a block conflicted out), minus any whose
   * parents it does not know.
   */
  #view(state: State, endpoint: Required<EndpointOptions>, now: number): View {
    const { lag, mempoolDelayMs, lightMode } = endpoint;
    const tip = state.chain.length - 1;
    const height = Math.max(0, tip - lag);
    const key = `${height}:${mempoolDelayMs > 0 ? now - mempoolDelayMs : '-'}:${lightMode}`;
    const cache = this.#views.get(state) ?? new Map<string, View>();
    this.#views.set(state, cache);
    const cached = cache.get(key);
    if (cached) return cached;
    const candidates: Entry[] = [];
    for (let h = height + 1; h <= tip; h++) {
      const block = state.chain[h] as Block;
      candidates.push(...block.evicted);
      candidates.push(...block.entries.filter((entry) => block.relayed.has(entry.txid)));
    }
    for (const { entry, time } of state.mempool.values()) {
      if (time + mempoolDelayMs <= now) candidates.push(entry);
    }
    const known = new Set<string>();
    const inView = (txid: string) => {
      const confirmed = state.confirmed.get(txid);
      return (confirmed !== undefined && confirmed <= height) || known.has(txid);
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of candidates) {
        if (known.has(entry.txid)) continue;
        if (entry.kind !== 'tx' || entry.ins.every((input) => inView(input.txid))) {
          known.add(entry.txid);
          changed = true;
        }
      }
    }
    const pooled = new Map<string, Entry>();
    for (const entry of candidates)
      if (known.has(entry.txid)) pooled.set(entry.txid, entry);
    const spentBy = new Map<string, string>();
    const spend = (entry: Entry) => {
      if (entry.kind !== 'tx') return;
      for (const input of entry.ins) {
        const key = outpointOf(input.txid, input.vout);
        if (!spentBy.has(key)) spentBy.set(key, entry.txid);
      }
    };
    for (let h = 0; h <= height; h++) (state.chain[h] as Block).entries.forEach(spend);
    pooled.forEach(spend);
    const view: View = { height, lightMode, pooled, spentBy };
    cache.set(key, view);
    return view;
  }

  #confirmedIn(state: State, view: View, txid: string): number | undefined {
    const height = state.confirmed.get(txid);
    return height !== undefined && height <= view.height ? height : undefined;
  }

  /** A transaction as the endpoint serves it: confirmed, in its mempool, or in its txstore. */
  #lookup(state: State, view: View, txid: string): Entry | undefined {
    if (this.#confirmedIn(state, view, txid) !== undefined)
      return state.archive.get(txid);
    const pooled = view.pooled.get(txid);
    if (pooled) return pooled;
    if (view.lightMode) return undefined;
    for (const block of state.stale.values()) {
      if (block.height > view.height) continue;
      const entry = block.entries.find((e) => e.txid === txid);
      if (entry) return state.archive.get(txid) ?? entry;
    }
    return undefined;
  }

  #status(state: State, view: View, txid: string): Record<string, unknown> {
    const height = this.#confirmedIn(state, view, txid);
    if (height === undefined) return { confirmed: false };
    const block = state.chain[height] as Block;
    return {
      confirmed: true,
      block_height: height,
      block_hash: block.hash,
      block_time: block.timestamp,
    };
  }

  #outputJson(output: Output): Record<string, unknown> {
    let address: string | undefined;
    try {
      address = bitcoin.address.fromOutputScript(output.script, this.network);
    } catch {
      address = undefined;
    }
    const s = output.script;
    const types: Partial<Record<ScriptType, string>> = {
      pubkey: 'p2pk',
      p2pkh: 'p2pkh',
      p2sh: 'p2sh',
      p2wpkh: 'v0_p2wpkh',
      p2wsh: 'v0_p2wsh',
      p2tr: 'v1_p2tr',
    };
    const type =
      s.length === 0
        ? 'empty'
        : s[0] === 0x6a
          ? 'op_return'
          : (types[solve(s)] ?? 'unknown');
    return {
      scriptpubkey: toHex(s),
      scriptpubkey_asm: '',
      scriptpubkey_type: type,
      ...(address !== undefined ? { scriptpubkey_address: address } : {}),
      value: Number(output.value),
    };
  }

  #txJson(state: State, view: View, entry: Entry): Record<string, unknown> {
    return {
      txid: entry.txid,
      version: entry.version,
      locktime: entry.locktime,
      vin: entry.ins.map((input, index) => ({
        txid: input.txid,
        vout: input.vout,
        prevout: entry.kind === 'tx' ? this.#outputJson(entry.prevouts[index]!) : null,
        scriptsig: toHex(input.script),
        scriptsig_asm: '',
        ...(input.witness.length > 0
          ? { witness: input.witness.map((w) => toHex(w)) }
          : {}),
        is_coinbase: entry.kind !== 'tx',
        sequence: input.sequence,
      })),
      vout: entry.outs.map((output) => this.#outputJson(output)),
      size: entry.size,
      weight: entry.weight,
      fee: Number(entry.fee),
      status: this.#status(state, view, entry.txid),
    };
  }

  #blockJson(block: Block): Record<string, unknown> {
    const txids = block.entries.map((entry) => entry.txid);
    let level = txids.map((txid) => fromHex(txid).reverse());
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        next.push(sha256(sha256(concatBytes(left, level[i + 1] ?? left))));
      }
      level = next;
    }
    const header = 80 + compactSizeLength(block.entries.length);
    return {
      id: block.hash,
      height: block.height,
      version: 0x20000000,
      timestamp: block.timestamp,
      tx_count: block.entries.length,
      size: header + block.entries.reduce((a, e) => a + e.size, 0),
      weight: header * 4 + block.entries.reduce((a, e) => a + e.weight, 0),
      merkle_root: reversedHex(level[0]!),
      previousblockhash: block.height === 0 ? null : block.parentHash,
      mediantime: block.mediantime,
      nonce: 0,
      bits: 0x207fffff,
      difficulty: 1,
    };
  }

  /** An address's output script, or electrs' refusal text. */
  #addressScript(address: string): Uint8Array | string {
    if (address.length <= 100) {
      try {
        return bitcoin.address.toOutputScript(address, this.network);
      } catch {
        const { bitcoin: main, testnet, regtest } = bitcoin.networks;
        for (const network of [main, testnet, regtest]) {
          try {
            bitcoin.address.toOutputScript(address, network);
            return 'Address on invalid network';
          } catch {
            // Not this network either.
          }
        }
      }
    }
    return 'Invalid Bitcoin address';
  }

  #addressStats(entries: Iterable<Entry>, script: Uint8Array): Record<string, number> {
    let fundedCount = 0;
    let funded = 0n;
    let spentCount = 0;
    let spent = 0n;
    let txCount = 0;
    for (const entry of entries) {
      let touched = false;
      for (const output of entry.outs) {
        if (!equalBytes(output.script, script)) continue;
        fundedCount++;
        funded += output.value;
        touched = true;
      }
      for (const prevout of entry.prevouts) {
        if (!equalBytes(prevout.script, script)) continue;
        spentCount++;
        spent += prevout.value;
        touched = true;
      }
      if (touched) txCount++;
    }
    return {
      funded_txo_count: fundedCount,
      funded_txo_sum: Number(funded),
      spent_txo_count: spentCount,
      spent_txo_sum: Number(spent),
      tx_count: txCount,
    };
  }

  #addressRoute(
    state: State,
    view: View,
    parts: readonly string[],
  ): FakeReply | undefined {
    const [, address, sub, chain, lastSeen] = parts;
    const n = parts.length;
    const shape =
      n === 2 ||
      (n === 3 && sub === 'utxo') ||
      ((n === 4 || n === 5) && sub === 'txs' && chain === 'chain');
    if (!shape) return undefined;
    const script = this.#addressScript(address as string);
    if (typeof script === 'string') return { status: 400, text: script };
    const confirmed = state.chain.slice(0, view.height + 1).flatMap((b) => b.entries);
    if (n === 2) {
      return {
        json: {
          address,
          chain_stats: this.#addressStats(confirmed, script),
          mempool_stats: this.#addressStats(view.pooled.values(), script),
        },
      };
    }
    if (sub === 'utxo') {
      const utxos: Record<string, unknown>[] = [];
      for (const entry of [...confirmed, ...view.pooled.values()]) {
        entry.outs.forEach((output, vout) => {
          if (!equalBytes(output.script, script)) return;
          if (view.spentBy.has(outpointOf(entry.txid, vout))) return;
          utxos.push({
            txid: entry.txid,
            vout,
            status: this.#status(state, view, entry.txid),
            value: Number(output.value),
          });
        });
      }
      return { json: utxos };
    }
    const touches = (entry: Entry) =>
      entry.outs.some((o) => equalBytes(o.script, script)) ||
      entry.prevouts.some((p) => equalBytes(p.script, script));
    const history = [...confirmed].reverse().filter(touches);
    // electrs ignores a cursor that is not a txid, and answers nothing after an unknown one.
    const cursor = lastSeen !== undefined ? parseHash(lastSeen) : undefined;
    let from = 0;
    if (cursor !== undefined) {
      from = history.findIndex((entry) => entry.txid === cursor) + 1;
      if (from === 0) return { json: [] };
    }
    return {
      json: history
        .slice(from, from + PAGE)
        .map((entry) => this.#txJson(state, view, entry)),
    };
  }

  #blockRoute(state: State, view: View, parts: readonly string[]): FakeReply | undefined {
    const [, id, sub, start] = parts;
    const n = parts.length;
    const shape =
      n === 2 || (n === 3 && sub === 'txids') || ((n === 3 || n === 4) && sub === 'txs');
    if (!shape) return undefined;
    const hash = parseHash(id as string);
    if (hash === undefined) return { status: 400, text: 'Invalid hex string' };
    const active = state.chain.find((b) => b.hash === hash && b.height <= view.height);
    if (n === 2) {
      return active
        ? { json: this.#blockJson(active) }
        : { status: 404, text: 'Block not found' };
    }
    // electrs keeps a disconnected block's txids and transactions.
    const stale = state.stale.get(hash);
    const block = active ?? (stale && stale.height <= view.height ? stale : undefined);
    if (!block) return { status: 404, text: 'Block not found' };
    if (sub === 'txids') return { json: block.entries.map((entry) => entry.txid) };
    const first = start === undefined ? 0 : (parseNumber(start, 0xffffffff) ?? 0);
    if (first >= block.entries.length) {
      return { status: 404, text: 'start index out of range' };
    }
    if (first % PAGE !== 0) {
      return { status: 400, text: `start index must be a multipication of ${PAGE}` };
    }
    return {
      json: block.entries
        .slice(first, first + PAGE)
        .map((entry) => this.#txJson(state, view, entry)),
    };
  }

  #txRoute(state: State, view: View, parts: readonly string[]): FakeReply | undefined {
    const [, id, sub, index] = parts;
    const n = parts.length;
    const shape =
      n === 2 ||
      (n === 3 && (sub === 'hex' || sub === 'status')) ||
      (n === 4 && sub === 'outspend');
    if (!shape) return undefined;
    const txid = parseHash(id as string);
    if (txid === undefined) return { status: 400, text: 'Invalid hex string' };
    if (sub === 'status') return { json: this.#status(state, view, txid) };
    if (sub === 'outspend') {
      const vout = parseNumber(index as string, 0xffffffff);
      if (vout === undefined) return { status: 400, text: 'Invalid number' };
      const spender = view.spentBy.get(outpointOf(txid, vout));
      if (spender === undefined) return { json: { spent: false } };
      const entry = this.#lookup(state, view, spender) as Entry;
      return {
        json: {
          spent: true,
          txid: spender,
          vin: entry.ins.findIndex((i) => i.txid === txid && i.vout === vout),
          status: this.#status(state, view, spender),
        },
      };
    }
    const entry = this.#lookup(state, view, txid);
    if (!entry) return { status: 404, text: 'Transaction not found' };
    return sub === 'hex'
      ? { text: entry.hex }
      : { json: this.#txJson(state, view, entry) };
  }
}

/** A txid or block hash as electrs parses one (either case), lowercased. */
function parseHash(value: string): string | undefined {
  return /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined;
}

/** An unsigned integer up to `max`, as Rust's `parse` reads one. */
function parseNumber(value: string, max: number): number | undefined {
  if (!/^\+?\d{1,20}$/.test(value)) return undefined;
  const number = Number(value.replace('+', ''));
  return number <= max ? number : undefined;
}
