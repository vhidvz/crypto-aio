/**
 * Every decoder that reads bytes a node, an indexer or a peer sent us, fed random and
 * mutated input. A decoder of untrusted bytes may answer "not readable" (its `null`,
 * `undefined` or `'malformed'`) or throw its own classified error; it must never throw
 * anything else (a TypeError or RangeError would escape classification and could read as
 * a provider failure on a verdict path), and it must stay fast on any input. Seeded, so a
 * failure reproduces.
 */
import { readSentTx } from '../../src/adapters/evm/rawtx';
import { parseSignedTx, parseUnsignedTx } from '../../src/adapters/avalanche/codec';
import { cb58Decode } from '../../src/adapters/avalanche/cb58';
import { compileLegacyMessage } from '../../src/adapters/solana/message';
import {
  memo,
  setComputeUnitLimit,
  systemTransfer,
  transferChecked,
} from '../../src/adapters/solana/programs';
import {
  decodeLength,
  messageSigners,
  parseMessage,
  parseSignedTransaction,
  signedTransaction,
} from '../../src/adapters/solana/wire';
import { transferAmount } from '../../src/adapters/tron/codec';
import { wireFields } from '../../src/adapters/tron/protobuf';
import { readTx, readTxHex } from '../../src/adapters/utxo/rawtx';
import { isCryptoAioError } from '../../src/core/errors/error';
import { fromHex, toHex } from '../../src/core/util/bytes';
import { parseJson } from '../../src/core/util/json';
import { VECTORS as EVM_VECTORS } from '../adapters/evm/support/vectors';
import { KEY_ADDRESS, MINT, RECIPIENT } from '../adapters/solana/support/vectors';
import { VECTORS as TRON_VECTORS } from '../adapters/tron/support/vectors';
import { fundingTx, signedSpend } from '../adapters/utxo/support/tx';
import { TEST_KEY } from '../adapters/utxo/support/vectors';
import { configOf } from '../adapters/avalanche/support/vectors';

/** More in the nightly run (`CRYPTO_AIO_FUZZ_ROUNDS`). */
const ROUNDS = Number(process.env.CRYPTO_AIO_FUZZ_ROUNDS ?? 1_500);

/** A small linear congruential generator: deterministic, so a failing input reproduces. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };
  const below = (n: number) => next() % n;
  const bytes = (length: number) => Uint8Array.from({ length }, () => below(256));
  /** `seed` with a few random edits: flips, truncation, extension, insertion, deletion. */
  const mutate = (seed: Uint8Array): Uint8Array => {
    let out = Uint8Array.from(seed);
    for (let edits = 1 + below(4); edits > 0; edits--) {
      const at = out.length === 0 ? 0 : below(out.length);
      switch (below(5)) {
        case 0:
          if (out.length > 0) out[at] = (out[at] as number) ^ (1 << below(8));
          break;
        case 1:
          out = out.slice(0, at);
          break;
        case 2:
          out = Uint8Array.from([...out, ...bytes(1 + below(16))]);
          break;
        case 3:
          out = Uint8Array.from([...out.slice(0, at), below(256), ...out.slice(at)]);
          break;
        default:
          out = Uint8Array.from([...out.slice(0, at), ...out.slice(at + 1)]);
      }
    }
    return out;
  };
  return { below, bytes, mutate };
}

/**
 * Runs `decode` on random and mutated inputs. It may return anything, or throw a
 * crypto-aio error when `throws` allows it; any other throw fails with the input in hex.
 */
function fuzz(
  name: string,
  seeds: readonly Uint8Array[],
  decode: (input: Uint8Array) => unknown,
  throws: 'never' | 'classified' = 'never',
): void {
  const random = generator(name.length * 7_919 + seeds.length);
  const started = Date.now();
  for (let round = 0; round < ROUNDS; round++) {
    const input =
      round % 2 === 0 || seeds.length === 0
        ? random.bytes(random.below(320))
        : random.mutate(seeds[random.below(seeds.length)] as Uint8Array);
    try {
      decode(input);
    } catch (error) {
      if (throws === 'classified' && isCryptoAioError(error)) continue;
      throw new Error(`${name} threw ${String(error)} on ${toHex(input)}`);
    }
  }
  // Linear decoders over at most a few hundred bytes: a slow one is a hang in waiting.
  expect((Date.now() - started) / ROUNDS).toBeLessThan(15);
}

describe('decoders of untrusted bytes, fuzzed', () => {
  it('Solana: compact lengths, messages and signed transactions', () => {
    const messages = [
      compileLegacyMessage(KEY_ADDRESS, KEY_ADDRESS, [
        setComputeUnitLimit(10_000n),
        systemTransfer(KEY_ADDRESS, RECIPIENT, 5n),
        memo('fuzz'),
      ]),
      compileLegacyMessage(KEY_ADDRESS, RECIPIENT, [
        transferChecked(KEY_ADDRESS, MINT, RECIPIENT, KEY_ADDRESS, 1n, 6),
      ]),
    ];
    const signed = messages.map((m) =>
      signedTransaction([new Uint8Array(64).fill(7)], m),
    );
    fuzz('solana message', messages, (bytes) => {
      parseMessage(bytes);
      messageSigners(bytes);
    });
    fuzz('solana signed', signed, (bytes) => parseSignedTransaction(bytes));
    fuzz('solana length', [Uint8Array.of(0x80, 0x80, 0x01)], (bytes) => {
      for (let offset = 0; offset <= bytes.length; offset++) decodeLength(bytes, offset);
    });
  });

  it('Tron: protobuf fields and transfer amounts', () => {
    const seeds = TRON_VECTORS.flatMap((v) => [fromHex(v.rawHex), fromHex(v.signed)]);
    fuzz('tron protobuf', seeds, (bytes) => {
      wireFields(bytes, 'opaque');
      wireFields(bytes, 'refuse');
    });
    fuzz('tron amount', seeds, (bytes) => transferAmount(toHex(bytes)));
  });

  it('Bitcoin: raw transactions, as bytes and as hex', () => {
    const funding = fundingTx(new Uint8Array(22).fill(1), 50_000n, 3);
    const spend = signedSpend(
      TEST_KEY,
      [[funding.getId(), 0, 50_000n]],
      [[new Uint8Array(22).fill(2), 40_000n]],
    );
    const seeds = [funding.toBuffer(), fromHex(spend)].map((b) => Uint8Array.from(b));
    fuzz('utxo bytes', seeds, (bytes) => readTx(bytes));
    fuzz('utxo hex', seeds, (bytes) => readTxHex(toHex(bytes)));
  });

  it('EVM: sent transaction bytes', () => {
    const seeds = EVM_VECTORS.map((v) => fromHex(v.raw.slice(2)));
    fuzz('evm sent', seeds, (bytes) => readSentTx(`0x${toHex(bytes)}`));
  });

  it('Avalanche: signed and unsigned transactions, and cb58 ids', () => {
    for (const vm of ['avm', 'pvm'] as const) {
      const config = configOf(vm);
      fuzz(
        `avalanche ${vm} signed`,
        [],
        (bytes) => parseSignedTx(bytes, config),
        'classified',
      );
      fuzz(
        `avalanche ${vm} unsigned`,
        [],
        (bytes) => parseUnsignedTx(bytes, config),
        'classified',
      );
    }
    fuzz('cb58', [], (bytes) => cb58Decode(new TextDecoder().decode(bytes)));
  });

  it('JSON answers with exact integers: any text parses or throws a SyntaxError', () => {
    const seeds = ['{"a":[1,2.5,-3e2,"x",true,null,{"b":12345678901234567890}]}'].map(
      (s) => new TextEncoder().encode(s),
    );
    const random = generator(17);
    for (let round = 0; round < ROUNDS; round++) {
      const text = new TextDecoder().decode(random.mutate(seeds[0] as Uint8Array));
      try {
        parseJson(text, true);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw new Error(`parseJson threw ${String(error)} on ${JSON.stringify(text)}`);
        }
      }
    }
  });
});
