/**
 * Proofs and block scanning (spec §6.7, §10). Every proof read is a quorum read under
 * `PROOF` (R33), comparing only consensus facts (`rpc.ts`, R59). No proof lets one endpoint
 * choose the final height (R74): a proof attests the fact it needs at that fact's own
 * height, so honest endpoints disagree only while it is final on one and not yet on another,
 * which decides nothing. The block source serves dense heights with native transfers and
 * ERC-20 `Transfer` logs, as the chain reports them (R68). Every error thrown here is a
 * `PROVIDER_*` code, retryable by the code table: look again later.
 */
import type { BlockSource, ProofSource } from '../../core/driver/types';
import { ProviderError, isCryptoAioError } from '../../core/errors/error';
import type { OrderingData } from '../../core/model/ordering';
import { quantity } from './client';
import { decodeTransaction, tokenTransferLanded } from './decode';
import {
  MONITOR,
  PROOF,
  finalBlockAt,
  provenFinal,
  toDriverBlock,
  type EvmContext,
} from './reader';
import { blockTransactionsKey } from './rpc';
import type { EvmTx } from './types';

/**
 * R74: a quorum key under which every endpoint whose nonce is past `nonce` agrees. A
 * malformed answer throws, which the transport counts as a disagreement.
 */
const nonceAbove =
  (nonce: bigint) =>
  (result: unknown): boolean =>
    quantity(result, 'nonce') > nonce;

/**
 * R85: node texts for state it does not hold: pruned, beyond its recent-state window, or
 * not served at a tag (geth, op-geth, Nitro, BSC, Erigon, Reth, Besu wordings).
 */
const STATE_UNAVAILABLE =
  /missing trie node|historical state .* not available|header not found|state (is )?not available|pruned/i;

/**
 * R85, R86 (lesson 18): the boundary of every proof. Only a definitive negative answer may
 * say "no", and a JSON-RPC error answer is none: state the node does not hold, an index it
 * is still building (geth's "transaction indexing is in progress"), or any other error,
 * ambiguous or not. Every `RPC_ERROR` becomes a retryable `PROVIDER_UNAVAILABLE` (look again
 * later, or elsewhere) that carries it as its cause, so no caller takes it for an answer and
 * the monitor keeps watching. Every other error passes unchanged: `PROVIDER_MISCONFIGURED`
 * stays final, and aborts and foreign errors stay what they are.
 */
async function undecided<T>(proof: () => Promise<T>): Promise<T> {
  try {
    return await proof();
  } catch (error) {
    if (!isCryptoAioError(error, 'RPC_ERROR')) throw error;
    const message = String(error.details?.rpcMessage ?? error.message);
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      STATE_UNAVAILABLE.test(message)
        ? 'finalized state not available'
        : 'the endpoints gave no answer',
      { cause: error },
    );
  }
}

/** A retryable "decide nothing": look again later, or elsewhere. */
const undecidable = (reason: string) => new ProviderError('PROVIDER_UNAVAILABLE', reason);

/**
 * R88: at most this many nonce reads look for the height that consumed a nonce. The gallop
 * and the bisection take about two reads per doubling of the distance back, so this reaches
 * 2^32 blocks: every consumption on any chain served today.
 */
const MAX_SEARCH_READS = 64;

/**
 * R88: the lowest height at or below `final` where `consumed` holds, given that it holds at
 * `final`. A gallop back (`final` less 1, 2, 4, …) finds a height where it does not, then a
 * bisection the first where it does. `consumed` never turns false again as the height
 * grows, since an account's nonce never falls. Beyond `MAX_SEARCH_READS` reads, it decides
 * nothing.
 */
export async function consumptionHeight(
  consumed: (height: bigint) => Promise<boolean>,
  final: bigint,
): Promise<bigint> {
  let reads = 0;
  const read = (height: bigint): Promise<boolean> => {
    if (reads === MAX_SEARCH_READS) {
      throw undecidable('the nonce was consumed too far back to look up');
    }
    reads += 1;
    return consumed(height);
  };
  // Consumed at `high`; not at `low` (below genesis, until a read says otherwise).
  let high = final;
  let low = -1n;
  for (let step = 1n; high > 0n && low < 0n; step *= 2n) {
    const height = final > step ? final - step : 0n;
    if (await read(height)) high = height;
    else low = height;
  }
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (await read(middle)) high = middle;
    else low = middle;
  }
  return high;
}

type Inclusion = Awaited<ReturnType<ProofSource['includedFinal']>>;

/**
 * R88 (the final review's C1): whether `txHash` is final, when no endpoint serves its
 * receipt. `null` is no proof of absence: a node answers it for every transaction outside its
 * index (geth indexes the last 2,350,000 blocks by default, and pruning nodes of other
 * clients drop theirs), so "not included" would prove a final, executed transfer `replaced`.
 * The nonce's consumer decides instead. The quorum attests the nonce consumed at a final
 * height, a search finds the block that consumed it, and the sender's transaction at that
 * nonce there answers: another one proves ours is not included; ours is included, with the
 * verdict its receipt in that block gives (R50). Anything else decides nothing, and so does
 * an endpoint without the historical state the search reads.
 */
async function nonceConsumer(
  ctx: EvmContext,
  txHash: string,
  ordering: OrderingData,
  from: string,
): Promise<Inclusion> {
  if (ordering.kind !== 'nonce')
    throw undecidable('no nonce to look the transaction up by');
  const { client } = ctx;
  const { nonce } = ordering;
  const tags = { ...PROOF, quorumKey: nonceAbove(nonce) };
  const consumed = async (height: bigint) =>
    (await client.getTransactionCount(from, height, tags)) > nonce;
  const { height: final } = await provenFinal(ctx, PROOF);
  if (!(await consumed(final)))
    throw undecidable('the nonce is not consumed at finality');
  const height = await consumptionHeight(consumed, final);
  const block = await client.getBlockWithTransactions(height, {
    ...PROOF,
    quorumKey: blockTransactionsKey,
  });
  if (block?.number !== height) throw undecidable('the endpoints serve no final block');
  const sender = from.toLowerCase();
  const consumer = block.transactions.find(
    (tx) => tx.from.toLowerCase() === sender && tx.nonce === nonce,
  );
  // No transaction from the sender used the nonce: an EIP-7702 authorization can.
  if (!consumer) throw undecidable('no transaction in its block used the nonce');
  // Another transaction is final at our nonce: ours can never be included.
  if (consumer.hash !== txHash.toLowerCase()) return { included: false };
  const receipts = await client.getBlockReceipts(block.hash, PROOF);
  const receipt = receipts?.find((r) => r.transactionHash === consumer.hash);
  if (receipt?.blockHash !== block.hash) {
    throw undecidable('the final block has no receipts on the endpoints');
  }
  return {
    included: true,
    success: receipt.status === 1 && tokenTransferLanded(client.abi, consumer, receipt),
    blockHeight: height,
    blockHash: block.hash,
    txHash: consumer.hash,
  };
}

export function createEvmProofs(ctx: EvmContext): ProofSource {
  const { client } = ctx;
  return {
    finalizedHead: () =>
      undecided(async () => {
        const { height, block } = await provenFinal(ctx, PROOF);
        const final = block ?? (await client.getBlock(height, PROOF));
        if (!final) {
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the endpoints serve no finalized block',
          );
        }
        return { height: final.number, hash: final.hash, timestamp: final.timestamp };
      }),

    includedFinal: (ref, ordering, from) =>
      undecided(async () => {
        const receipt = await client.getReceipt(ref.id, PROOF);
        // R88: no receipt is no proof of absence; the transaction at our nonce decides.
        if (!receipt) return nonceConsumer(ctx, ref.id, ordering, from);
        const final = await finalBlockAt(ctx, receipt.blockNumber, PROOF);
        // R77: the transaction is in a block, just not a final one on these endpoints yet.
        // "Not included" would let the core prove a final transfer `replaced` (whenAbsent,
        // after the slot was proven consumed on endpoints whose finality is further along),
        // so this decides nothing.
        if (!final) {
          throw new ProviderError('PROVIDER_UNAVAILABLE', 'receipt not yet final');
        }
        // The endpoints agree on a receipt from a block that is not the final one at its
        // height: the chain reorganized between the reads, or their receipt index lags. The
        // transaction may be final elsewhere, so this decides nothing (R74).
        if (final.hash !== receipt.blockHash) {
          throw new ProviderError(
            'PROVIDER_INCONSISTENT',
            'the receipt is not in the final block at its height',
          );
        }
        let success = receipt.status === 1;
        if (success) {
          // R50: a token transfer that logged nothing moved nothing (read from the ref
          // alone). The core proves only its own Attempts, so this is always a verdict (R68).
          const tx = await client.getTransaction(ref.id, PROOF);
          if (!tx) {
            throw new ProviderError(
              'PROVIDER_INCONSISTENT',
              'a receipt without its transaction',
            );
          }
          success = tokenTransferLanded(client.abi, tx, receipt);
        }
        return {
          included: true,
          success,
          blockHeight: receipt.blockNumber,
          blockHash: receipt.blockHash,
          txHash: receipt.transactionHash,
        };
      }),

    slotConsumed: (ordering, from, level) =>
      undecided(async () => {
        if (ordering.kind !== 'nonce') return false;
        if (level === 'latest') {
          return (
            (await client.getTransactionCount(from, 'latest', MONITOR)) > ordering.nonce
          );
        }
        // R85: the nonce at a height the quorum attests final (one endpoint's view proposes
        // it, trailed by PEER_SKEW), on tag and confirmation networks alike. State at a final
        // height never changes, so honest endpoints agree however their heads move, and one
        // that over-reports its finalized block cannot advance the height (R74). A number,
        // not the `finalized` tag: some nodes (BSC's) serve no state at the tag.
        const { height } = await provenFinal(ctx, PROOF);
        const count = await client.getTransactionCount(from, height, {
          ...PROOF,
          quorumKey: nonceAbove(ordering.nonce),
        });
        return count > ordering.nonce;
      }),

    // Nonce ordering: an EVM transaction never expires.
    expired: async () => false,

    blockHash: (height, level) =>
      undecided(async () => {
        if (level === 'finalized') {
          return (await finalBlockAt(ctx, height, PROOF))?.hash ?? null;
        }
        return (await client.getBlock(height, PROOF))?.hash ?? null;
      }),
  };
}

const changed = (height: bigint) =>
  new ProviderError('PROVIDER_INCONSISTENT', `block ${height} changed while scanning`);

export function createEvmBlocks(ctx: EvmContext): BlockSource {
  const { client, config } = ctx;
  return {
    async header(height) {
      const block = await client.getBlock(height, MONITOR);
      return block ? toDriverBlock(block) : null;
    },

    async transactions(block, filter) {
      const full = await client.getBlockWithTransactions(block.height, MONITOR);
      if (!full || full.hash !== block.hash) throw changed(block.height);
      let selected: readonly EvmTx[] = full.transactions;
      if (filter?.addresses?.length) {
        const wanted = new Set(filter.addresses.map((a) => a.toLowerCase()));
        const watched = (address: string | null) =>
          address !== null && wanted.has(address.toLowerCase());
        const logs = await client.getLogs(
          { blockHash: block.hash, topics: [client.abi.transferTopic] },
          MONITOR,
        );
        const tokenTxs = new Set(
          logs
            .filter((log) => {
              const transfer = client.abi.decodeTransfer(log);
              return (
                transfer !== null && (watched(transfer.from) || watched(transfer.to))
              );
            })
            .map((log) => log.transactionHash),
        );
        // A contract creation's recipient is only in its receipt, so every creation stays.
        selected = full.transactions.filter(
          (tx) =>
            tx.to === null || watched(tx.from) || watched(tx.to) || tokenTxs.has(tx.hash),
        );
      }
      const receipts = await Promise.all(
        selected.map((tx) => client.getReceipt(tx.hash, MONITOR)),
      );
      return selected.map((tx, i) => {
        const receipt = receipts[i] ?? null;
        if (!receipt || receipt.blockHash !== block.hash) throw changed(block.height);
        // The chain's view (R68), with the network's config so bor's system logs do not
        // make a plain Polygon transfer `partial` (R69, R70).
        return decodeTransaction(client.abi, tx, receipt, full.timestamp, config);
      });
    },
  };
}
