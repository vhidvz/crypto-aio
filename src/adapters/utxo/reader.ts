/**
 * Bitcoin addresses, point reads, observation, address history and `ext.utxo.listUnspent`.
 * Every call carries the tags of the `ChainDriver` contract table: `read` for point
 * queries, `monitor` for heights and observations; address reads go to the indexer.
 */
import type {
  AddressCodec,
  AddressHistorySource,
  ChainReader,
  DriverBlock,
  DriverTransaction,
} from '../../core/driver/types';
import { ProviderError, ValidationError } from '../../core/errors/error';
import type { NormalizedAddress } from '../../core/model/address';
import { toHex } from '../../core/util/bytes';
import { decodeAddress, walletAddress } from './address';
import {
  MONITOR,
  READ,
  assertNative,
  parseOutpoint,
  proofRead,
  parseWalletOptions,
  withSignal,
  type UtxoContext,
} from './context';
import { canonicalTwinTxid, txidOfHex } from './codec';
import { decodeTransaction, observationOf } from './decode';
import { MAX_MONEY, isHash, malformed } from './esplora';
import type { EsploraTx, UtxoCallTags, UtxoOutputType, UtxoUnspent } from './types';

/** Esplora's page of address history (electrs' `CHAIN_TXS_PER_PAGE`). */
const HISTORY_PAGE = 25;
const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);

/** Two reads of one index that contradict each other decide nothing (retryable). */
const contradiction = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

const normalized = (canonical: string, type: UtxoOutputType): NormalizedAddress => ({
  canonical,
  display: canonical,
  variant: { type },
});

export function addressCodec(ctx: UtxoContext): AddressCodec {
  const params = ctx.config.address;
  return {
    validate: (address) => {
      try {
        decodeAddress(address, params);
        return true;
      } catch {
        return false;
      }
    },
    normalize: (address) => {
      const decoded = decodeAddress(address, params);
      return normalized(decoded.canonical, decoded.type);
    },
    fromPublicKey: (publicKey, wallet) => {
      const { addressType } = parseWalletOptions(wallet, ctx.config);
      const derived = walletAddress(publicKey, addressType, params);
      return normalized(
        derived.address,
        derived.type === 'p2sh-p2wpkh' ? 'p2sh' : derived.type,
      );
    },
  };
}

/** The key hash of a p2pkh sending address, or `undefined` for every other type. */
function p2pkhKeyHash(ctx: UtxoContext, from: string): Uint8Array | undefined {
  try {
    const decoded = decodeAddress(from, ctx.config.address);
    return decoded.type === 'p2pkh' ? decoded.script.slice(3, 23) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * C2: whether `spender` is a miner-malleated copy of our p2pkh Attempt `refId`. Its raw
 * bytes are read under `tags` and authenticate themselves: under a quorum the answers are
 * keyed on the txid they hash to, and the client refuses bytes that do not hash to
 * `spender` (a retryable `PROVIDER_INCONSISTENT`). They are then canonicalized: equality
 * with `refId` proves the same version, lock time, outpoints, sequences and outputs. Segwit
 * and taproot txids exclude the witness and cannot be malleated, so nothing is read for them.
 */
export async function isOwnCopy(
  ctx: UtxoContext,
  refId: string,
  from: string,
  spender: string,
  tags: UtxoCallTags,
): Promise<boolean> {
  const keyHash = p2pkhKeyHash(ctx, from);
  if (!keyHash) return false;
  const hex = await ctx.esplora.txHex(spender, {
    ...tags,
    ...(tags.quorum !== undefined
      ? { quorumKey: (answer: unknown) => txidOfHex(String(answer).trim()) }
      : {}),
  });
  if (hex === null) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'the spending transaction is not available',
    );
  }
  return canonicalTwinTxid(hex, keyHash) === refId;
}

/** The highest block with the network's confirmations, from one `monitor` read. */
export function finalizedFromHead(ctx: UtxoContext, head: bigint): bigint {
  const height = head - BigInt(ctx.config.confirmations) + 1n;
  return height < 0n ? 0n : height;
}

export function chainReader(ctx: UtxoContext): ChainReader {
  const { esplora, config } = ctx;
  const block = async (hash: string, height?: bigint): Promise<DriverBlock | null> => {
    const found = await esplora.block(hash, READ);
    if (!found) return null;
    // I2: the block at a height must say it is at that height. A block's height never
    // changes, so only a lie or a server bug trips this; it decides nothing (retryable).
    if (height !== undefined && found.height !== height) {
      throw contradiction('the block at the height asked for is at another height');
    }
    const transactionIds = await esplora.blockTxids(found.hash, READ);
    if (transactionIds.length !== found.txCount) throw malformed('block txids');
    return {
      height: found.height,
      hash: found.hash,
      parentHash: found.parentHash,
      timestamp: found.timestamp,
      transactionIds,
    };
  };
  return {
    getBalance: async (address, asset) => {
      assertNative(asset);
      const stats = await esplora.addressStats(
        decodeAddress(address, config.address).canonical,
        READ,
      );
      return stats.funded - stats.spent;
    },
    getBlockHeight: () => esplora.tipHeight(MONITOR),
    getFinalizedHeight: async () =>
      finalizedFromHead(ctx, await esplora.tipHeight(MONITOR)),
    getBlock: async (ref) => {
      if (typeof ref === 'string') {
        const id = ref.toLowerCase();
        return isHash(id) ? block(id) : null; // I2: a malformed id never reaches a path
      }
      // No block is below 0 or beyond what a server can parse: never sent (I2).
      if (ref < 0n || ref > MAX_HEIGHT) return null;
      const hash = await esplora.blockHashAt(ref, READ);
      return hash ? block(hash, ref) : null;
    },
    getTransaction: async (raw) => {
      const id = raw.toLowerCase();
      if (!isHash(id)) return null; // I2
      const tx = await esplora.tx(id, READ);
      return tx ? decodeTransaction(tx, config.address) : null;
    },
    observe: async (ref, ordering, from) => {
      const id = ref.id.toLowerCase();
      if (!isHash(id)) return { seen: 'none' }; // I2
      // Lesson 18, widened: a refusal on any of these reads decides nothing (retryable).
      return proofRead(async () => {
        // `/tx/:txid/status` answers `confirmed: false` for a transaction it does not know,
        // so visibility is read from `/tx/:txid`, which is a 404 then.
        const tx = await esplora.tx(id, MONITOR);
        if (tx?.status.confirmed) return observationOf(tx.txid, tx.status);
        const first = ordering?.kind === 'inputs' ? ordering.inputs[0] : undefined;
        // A status lookup by id (no ordering) reports the index as it is.
        if (first === undefined)
          return tx ? observationOf(tx.txid, tx.status) : { seen: 'none' };
        const legacy = from !== undefined && p2pkhKeyHash(ctx, from) ? from : undefined;
        // Unknown, and a segwit or taproot txid cannot be malleated: nothing more to learn.
        if (!tx && legacy === undefined) return { seen: 'none' };
        const input = parseOutpoint(first);
        // F3-R8: full-mode electrs keeps serving a reorg-dropped transaction as unconfirmed,
        // and `/status` cannot tell a mempool transaction from one only in its txstore. The
        // first input's spender can: chain spends of a disconnected block are gone, then the
        // mempool's are read. Ours: in a mempool. None: in no mempool of this index (the core
        // rebroadcasts a dropped Attempt). Another: conflicted, or our malleated copy (C2).
        // Observed evidence only: an index still syncing can briefly say otherwise.
        const spend = await esplora.outspend(input.txid, input.vout, MONITOR);
        if (!spend.spent || spend.txid === undefined) return { seen: 'none' };
        if (spend.txid === id) {
          if (tx) return observationOf(tx.txid, tx.status);
          throw contradiction('the index spends with a transaction it does not know');
        }
        // C2: our own p2pkh Attempt, mined as a malleated copy (observed evidence only; only
        // `includedFinal`'s quorum path can make it terminal).
        if (
          legacy === undefined ||
          !(await isOwnCopy(ctx, id, legacy, spend.txid, MONITOR))
        )
          return { seen: 'none' };
        const copy = await esplora.tx(spend.txid, MONITOR);
        if (!copy)
          throw contradiction('the index spends with a transaction it does not know');
        return observationOf(copy.txid, copy.status);
      });
    },
  };
}

/**
 * Confirmed history, newest first (Esplora pages of 25; the cursor is the last txid). A full
 * page, of any size a server chooses, may have a next one. The answer is filtered to the
 * address asked for (lesson 6): a server that dropped its filter never lists another
 * address's transaction, and every transaction served counts toward `limit`, so paging stays
 * bounded.
 */
export function addressHistory(ctx: UtxoContext): AddressHistorySource {
  return {
    async list(address, { cursor, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new ValidationError('INVALID_INTENT', 'limit must be a positive integer');
      }
      if (cursor !== undefined && !/^[0-9a-f]{64}$/.test(cursor)) {
        throw new ValidationError('INVALID_INTENT', 'malformed history cursor');
      }
      const decoded = decodeAddress(address, ctx.config.address);
      const script = toHex(decoded.script);
      const touches = (tx: EsploraTx) =>
        tx.vout.some((output) => output.script === script) ||
        tx.vin.some((input) => input.prevout?.script === script);
      const items: DriverTransaction[] = [];
      let served = 0;
      let last = cursor;
      let more = true;
      while (served < limit && more) {
        const page = await ctx.esplora.addressTxs(decoded.canonical, last, READ);
        const taken = page.slice(0, limit - served);
        for (const tx of taken) {
          if (touches(tx)) items.push(decodeTransaction(tx, ctx.config.address));
          last = tx.txid;
          served++;
        }
        more = taken.length < page.length || page.length >= HISTORY_PAGE;
      }
      return { items, ...(more && last !== undefined ? { next: last } : {}) };
    },
  };
}

/**
 * `ext.utxo.listUnspent`: confirmed first (oldest first), then unconfirmed. An output the
 * indexer names twice alike is listed once; named twice differently (another value or
 * status), the answer is malformed, and so is a list worth more than every bitcoin. Coin
 * selection reads the wallet's outputs through it (`spendable`, with the build's signal).
 */
export async function listUnspent(
  ctx: UtxoContext,
  address: string,
  signal?: AbortSignal,
): Promise<UtxoUnspent[]> {
  const canonical = decodeAddress(address, ctx.config.address).canonical;
  const listed = await ctx.esplora.addressUtxos(canonical, withSignal(READ, signal));
  const seen = new Map<string, string>();
  const utxos = listed.filter((u) => {
    const key = `${u.txid}:${u.vout}`;
    const { confirmed, blockHeight, blockHash, blockTime } = u.status;
    const facts = `${u.value}|${confirmed}|${blockHeight}|${blockHash}|${blockTime}`;
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, facts);
      return true;
    }
    if (known !== facts) throw malformed('an unspent output listed twice, differently');
    return false;
  });
  // Each value is in range (the parser), but no address holds more than every bitcoin: under
  // coinSelection `all`, such a listing would build change above MAX_MONEY (review M1).
  if (utxos.reduce((sum, u) => sum + u.value, 0n) > MAX_MONEY) {
    throw malformed('unspent outputs worth more than every bitcoin');
  }
  const height = (u: (typeof utxos)[number]) =>
    u.status.confirmed
      ? (u.status.blockHeight as bigint)
      : BigInt(Number.MAX_SAFE_INTEGER);
  return utxos
    .map((u) => ({ u, key: `${u.txid}:${u.vout}` }))
    .sort((a, b) =>
      height(a.u) === height(b.u)
        ? a.key < b.key
          ? -1
          : 1
        : height(a.u) < height(b.u)
          ? -1
          : 1,
    )
    .map(({ u, key }) => ({
      outpoint: key,
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status.confirmed,
      ...(u.status.confirmed ? { blockHeight: u.status.blockHeight as bigint } : {}),
    }));
}
