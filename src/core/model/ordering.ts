export type OrderingKind = 'nonce' | 'seqno' | 'inputs' | 'expiry';

/**
 * What reserves an Attempt's slot. A family's build may record more about a `seqno` or
 * `expiry` slot in the same object (TON's `validFrom`, Tron's `refBlockHash`, Solana's
 * `blockhash` and `blockhashSlot`, each in the family's own exported type), and its proofs
 * read those fields back. A store keeps every ordering whole and unchanged, extra fields
 * included: strings, finite numbers and bigints beyond 2^53. The `OperationStore` contract
 * suite checks each built-in family's (`SAMPLE_ORDERINGS`).
 */
export type OrderingData =
  | { readonly kind: 'nonce'; readonly nonce: bigint }
  | { readonly kind: 'seqno'; readonly seqno: bigint; readonly validUntil: number }
  | { readonly kind: 'inputs'; readonly inputs: readonly string[] }
  | {
      readonly kind: 'expiry';
      readonly lastValidHeight?: bigint;
      readonly expiresAtMs?: number;
    };

/** True when at most one of two transactions with these orderings can ever be included. */
export function mutuallyExclusive(a: OrderingData, b: OrderingData): boolean {
  if (a.kind === 'nonce' && b.kind === 'nonce') return a.nonce === b.nonce;
  if (a.kind === 'seqno' && b.kind === 'seqno') return a.seqno === b.seqno;
  if (a.kind === 'inputs' && b.kind === 'inputs') {
    return a.inputs.some((input) => b.inputs.includes(input));
  }
  return false;
}

/** Short label safe for events and logs (never lists inputs or addresses). */
export function orderingLabel(ordering: OrderingData): string {
  switch (ordering.kind) {
    case 'nonce':
      return `nonce:${ordering.nonce}`;
    case 'seqno':
      return `seqno:${ordering.seqno}`;
    case 'inputs':
      return `inputs:${ordering.inputs.length}`;
    case 'expiry':
      return 'expiry';
  }
}
