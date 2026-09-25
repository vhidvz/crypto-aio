// R37: a user's `declare module 'crypto-aio'` registry augmentation must survive whatever
// order the compiler reads files in, next to the testing kit's own fake-chain augmentation.
// Compiles a small consumer program against the sources, with `crypto-aio` and
// `crypto-aio/testing` mapped to the entry points, in both file orders.
import { join } from 'node:path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..', '..');
const VIRTUAL = join(ROOT, 'test', 'architecture', '__virtual__');

/** A plugin's augmentation, as networks.md shows it. */
const AUGMENT = `
export {};
declare module 'crypto-aio' {
  interface ChainRegistry { acmechain: { family: 'acme'; network: 'mainnet' } }
  interface FamilyRegistry { acme: { library: 'acme-sdk'; ext: { ping(): Promise<void> } } }
  interface NativeClientMap { 'acme-sdk': { hello(): string } }
}
`;

/** A consumer that also loads the testing kit, which registers the fake chains. */
const USE = `
import { CryptoAio } from 'crypto-aio';
import { createFakeEnv } from 'crypto-aio/testing';
const aio = new CryptoAio({ env: false });
export const acme = aio.blockchain({ chain: 'acmechain' });
export const fake = aio.blockchain({ chain: 'fakechain' });
export const env = createFakeEnv;
`;

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  types: ['node'],
  typeRoots: [join(ROOT, 'node_modules', '@types')],
  baseUrl: ROOT,
  paths: {
    'crypto-aio': [join(ROOT, 'src', 'index.ts')],
    'crypto-aio/testing': [join(ROOT, 'src', 'testing', 'index.ts')],
    'crypto-aio/evm': [join(ROOT, 'src', 'adapters', 'evm', 'index.ts')],
    'crypto-aio/native': [join(ROOT, 'src', 'native.ts')],
  },
};

/** Errors in the consumer files when the compiler gets `files` in this order. */
function compile(files: Record<string, string>, previous?: ts.Program) {
  const virtual = new Map(
    Object.entries(files).map(([name, text]) => [join(VIRTUAL, name), text]),
  );
  const host = ts.createCompilerHost(OPTIONS);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => virtual.has(file) || fileExists.call(host, file);
  host.readFile = (file) => virtual.get(file) ?? readFile.call(host, file);
  host.getSourceFile = (file, language, ...rest) => {
    const text = virtual.get(file);
    return text !== undefined
      ? ts.createSourceFile(file, text, language)
      : getSourceFile.call(host, file, language, ...rest);
  };
  const program = ts.createProgram([...virtual.keys()], OPTIONS, host, previous);
  const errors = [...virtual.keys()].flatMap((file): string[] => {
    const source = program.getSourceFile(file);
    if (!source) return [`${file} was not loaded`];
    const found = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ];
    return found.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  });
  return { program, errors };
}

describe('registry augmentation through the public entry (R37)', () => {
  it('keeps a user chain and the fake chains in both file orders', () => {
    const first = compile({ 'augment.ts': AUGMENT, 'use.ts': USE });
    expect(first.errors).toEqual([]);
    const second = compile({ 'use.ts': USE, 'augment.ts': AUGMENT }, first.program);
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('still rejects a chain nobody registered', () => {
    const { errors } = compile({ 'use.ts': USE.replace(/'acmechain'/g, "'nochain'") });
    expect(errors).toEqual([expect.stringContaining(`'"nochain"' is not assignable`)]);
  }, 120_000);
});

/** The EVM family's built-in chains are typed from the entry; its SDK clients from `crypto-aio/evm`. */
const USE_EVM = `
import { CryptoAio, type EvmFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/evm';
const aio = new CryptoAio({ env: false });
export const eth = aio.blockchain({ chain: 'ethereum', network: 'hoodi', library: 'web3' });
export const fee: EvmFeeOverride = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
export async function height(): Promise<number> {
  const provider = await native(aio.blockchain({ chain: 'base' }), 'ethers');
  return provider.getBlockNumber();
}
export async function chainId(): Promise<bigint> {
  return (await native(eth, 'web3')).eth.getChainId();
}
export async function nonce(): Promise<bigint> {
  return aio.blockchain({ chain: 'polygon', network: 'amoy' }).ext.evm.getNonce('0x0');
}
`;

/** A user's own native client next to the EVM ones: lost if `crypto-aio/evm` augments `ids` (R37). */
const USE_ACME = `
import { CryptoAio } from 'crypto-aio';
import { native } from 'crypto-aio/native';
const aio = new CryptoAio({ env: false });
export async function hello(): Promise<string> {
  return (await native(aio.blockchain({ chain: 'acmechain' }), 'acme-sdk')).hello();
}
`;

describe('EVM registry augmentation (R37)', () => {
  it('types the built-in EVM chains, networks, libraries, ext and native clients, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'evm.ts': USE_EVM,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      { 'acme.ts': USE_ACME, 'evm.ts': USE_EVM, 'augment.ts': AUGMENT },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the EVM family does not have', () => {
    const wrong = USE_EVM.replace("network: 'hoodi'", "network: 'goerli'").replace(
      "library: 'web3'",
      "library: 'tronweb'",
    );
    const { errors } = compile({ 'evm.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"goerli"' is not assignable`),
      expect.stringContaining(`'"tronweb"' is not assignable`),
    ]);
  }, 120_000);
});
