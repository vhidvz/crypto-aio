export type OrderingKind = 'nonce' | 'seqno' | 'inputs' | 'expiry';

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
