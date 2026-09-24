import { isTerminal, type OperationRecord } from '../store/types';

/** Inputs held by live Operations: their reservation, unsigned payload and every Attempt (spec §8.5). */
export function reservedInputs(
  operations: readonly OperationRecord[],
  exceptId?: string,
): string[] {
  const inputs = new Set<string>();
  for (const op of operations) {
    if (op.id === exceptId || isTerminal(op.state)) continue;
    if (op.reservation?.kind === 'inputs')
      for (const input of op.reservation.inputs) inputs.add(input);
    if (op.unsigned?.ordering.kind === 'inputs')
      for (const input of op.unsigned.ordering.inputs) inputs.add(input);
    for (const attempt of op.attempts) {
      if (attempt.ordering.kind === 'inputs')
        for (const input of attempt.ordering.inputs) inputs.add(input);
    }
  }
  return [...inputs].sort();
}

/** The live Operation that may still consume the wallet's current seqno (TON is strictly serial). */
export function seqnoHolder(
  operations: readonly OperationRecord[],
  exceptId?: string,
): OperationRecord | undefined {
  return operations.find(
    (op) =>
      op.id !== exceptId &&
      !isTerminal(op.state) &&
      op.state !== 'included' &&
      op.reservation?.kind === 'seqno',
  );
}

/**
 * The lowest nonce still reserved by a live, not-yet-included Operation. Included
 * nonces are already consumed on chain, so counting them would mask a gap above them.
 */
export function lowestOutstandingNonce(
  operations: readonly OperationRecord[],
): { nonce: bigint; operationId: string } | undefined {
  let lowest: { nonce: bigint; operationId: string } | undefined;
  for (const op of operations) {
    if (isTerminal(op.state) || op.state === 'included') continue;
    if (op.reservation?.kind !== 'nonce') continue;
    if (!lowest || op.reservation.nonce < lowest.nonce)
      lowest = { nonce: op.reservation.nonce, operationId: op.id };
  }
  return lowest;
}
