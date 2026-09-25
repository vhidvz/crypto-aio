import type { Transport } from './types';

/** What the stale-view guard reads from a transport. */
export type StaleViewSource = Pick<
  Transport,
  'highestHeight' | 'hasProbes' | 'maxLagBlocks'
>;

/**
 * I2: the one stale-view guard of the monitor and the scanner. A view whose `head` is more
 * than the transport's effective `maxLagBlocks` behind its verified high-water mark
 * (`highestHeight()`) is stale, and so is every view while health probes exist but no
 * height was verified yet. A stale view decides nothing: no reorg, drop, expiry or
 * rollback verdict.
 */
export function isStaleView(transport: StaleViewSource, head: bigint): boolean {
  const highest = transport.highestHeight();
  if (highest === undefined) return transport.hasProbes();
  return head + BigInt(transport.maxLagBlocks) < highest;
}
