/**
 * Test keys and vectors for the Avalanche family. Addresses are cross-checked against
 * avalanchejs's own formatter in the address tests.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  AVALANCHE_P_CHAIN,
  AVALANCHE_X_CHAIN,
} from '../../../../src/adapters/avalanche/chains';
import { avalancheNetworkConfig } from '../../../../src/adapters/avalanche/network';
import type { NetworkInfo } from '../../../../src/core/model/chain';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { toHex } from '../../../../src/core/util/bytes';

/** A test-only key: sha256('crypto-aio/avalanche test key'). Never fund it on a real network. */
export const TEST_KEY = sha256(utf8ToBytes('crypto-aio/avalanche test key'));
export const TEST_PUBKEY = secp256k1.getPublicKey(TEST_KEY, true);
export const TEST_BYTES = ripemd160(sha256(TEST_PUBKEY));

/** A stranger's key: sha256('crypto-aio/avalanche other key'). */
export const OTHER_KEY = sha256(utf8ToBytes('crypto-aio/avalanche other key'));
export const OTHER_PUBKEY = secp256k1.getPublicKey(OTHER_KEY, true);
export const OTHER_BYTES = ripemd160(sha256(OTHER_PUBKEY));

/** The scripted node's faucet: sha256('crypto-aio/avalanche faucet key'). */
export const FAUCET_KEY = sha256(utf8ToBytes('crypto-aio/avalanche faucet key'));
export const FAUCET_BYTES = ripemd160(sha256(secp256k1.getPublicKey(FAUCET_KEY, true)));

export function testSigner(id = 'hot') {
  return localSigner({ id, secp256k1: secret(toHex(TEST_KEY)) });
}

export type Vm = 'avm' | 'pvm';

export const chainOf = (vm: Vm) => (vm === 'avm' ? AVALANCHE_X_CHAIN : AVALANCHE_P_CHAIN);

export const networkOf = (vm: Vm, network: 'fuji' | 'mainnet' = 'fuji'): NetworkInfo =>
  chainOf(vm).networks[network] as NetworkInfo;

export const configOf = (
  vm: Vm,
  options: Readonly<Record<string, unknown>> = {},
  network: 'fuji' | 'mainnet' = 'fuji',
) => avalancheNetworkConfig(chainOf(vm), networkOf(vm, network), options);
