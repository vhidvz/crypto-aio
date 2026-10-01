// docs/reference/api.md names every value the package exports, from every entry point, and
// every public member of the handle and the container, so it cannot fall behind the code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as library from '../../src';
import * as avalanche from '../../src/adapters/avalanche';
import * as evm from '../../src/adapters/evm';
import * as solana from '../../src/adapters/solana';
import * as ton from '../../src/adapters/ton';
import * as tron from '../../src/adapters/tron';
import * as utxo from '../../src/adapters/utxo';
import * as nativeEntry from '../../src/native';
import * as testing from '../../src/testing';

const page = readFileSync(join(__dirname, '../../docs/reference/api.md'), 'utf8');

/** Whether the page names `name` in a code span: `name`, `name(…)`, `aio.name`, … */
function named(name: string): boolean {
  return new RegExp(`\`[^\`]*\\b${name.replace(/\$/g, '\\$')}\\b[^\`]*\``).test(page);
}

/** Family constants named by pattern on the page (each family's `…_CAPABILITIES`, …). */
const PATTERNS = [/_CAPABILITIES$/, /_PEER_DEPENDENCIES$/];

/** Public members, from the prototype, without the ones the declarations mark protected. */
function members(prototype: object, protectedNames: readonly string[]): string[] {
  return Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor' && !protectedNames.includes(name),
  );
}

describe('docs/reference/api.md', () => {
  it.each([
    ['crypto-aio', library],
    ['crypto-aio/testing', testing],
    ['crypto-aio/native', nativeEntry],
  ])('names every export of %s', (_entry, exports) => {
    const missing = Object.keys(exports).filter((name) => !named(name));
    expect(missing).toEqual([]);
  });

  it('names the family entry points and their notable exports', () => {
    const exports = { ...evm, ...utxo, ...tron, ...solana, ...ton, ...avalanche };
    const missing = Object.keys(exports).filter(
      (name) => !named(name) && !PATTERNS.some((pattern) => pattern.test(name)),
    );
    expect(missing).toEqual([]);
    for (const entry of ['evm', 'utxo', 'tron', 'solana', 'ton', 'avalanche']) {
      expect(page).toContain(`\`crypto-aio/${entry}\``);
    }
  });

  it('names every public method and property of the handle', () => {
    const internal = [
      'driverAddress',
      'mapping',
      'engine',
      'monitor',
      'readTarget',
      'target',
      'view',
      'submission',
      'prepared',
    ];
    const missing = members(library.Blockchain.prototype, internal).filter(
      (name) => !named(name),
    );
    expect(missing).toEqual([]);
    expect(named('Blockchain.create')).toBe(true);
  });

  it('names every public member of the container', () => {
    const missing = members(library.CryptoAio.prototype, []).filter(
      (name) => !named(name),
    );
    expect(missing).toEqual([]);
  });
});
