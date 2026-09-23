import type { SigningContext } from '../../../src/core/signing/types';

export const ctx: SigningContext = {
  operationId: 'op_1',
  namespace: 'default',
  chain: 'c',
  network: 'n',
  wallet: 'w',
  purpose: 'original',
  summary: { asset: 'c:n/native', outputs: [] },
  fee: { kind: 'x', speed: 'normal', charges: [], bound: 'exact', details: {} },
  unsignedHash: 'h',
};
