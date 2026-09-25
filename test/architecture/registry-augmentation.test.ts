// R37: a user's `declare module 'crypto-aio'` registry augmentation must survive whatever
// order the compiler reads files in, next to the testing kit's own fake-chain augmentation.
// Compiles a small consumer program against the sources, with `crypto-aio` and
// `crypto-aio/testing` mapped to the entry points, in both file orders. Last, the main
// entry's shipped declarations must type-check with no SDK installed (spec §5.6).
import { join, relative, sep } from 'node:path';
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

const message = (error: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(error.messageText, '\n');

/**
 * Compiler options, files the compiler must not see (as if never installed) and extra files
 * served from memory by absolute path.
 */
interface Setup {
  readonly options: ts.CompilerOptions;
  readonly hidden?: RegExp;
  readonly files?: ReadonlyMap<string, string>;
}

/**
 * Errors in the consumer files when the compiler gets `files` in this order; `everywhere()`
 * also reports the errors in every other file of the program, libraries included.
 */
function compile(
  files: Record<string, string>,
  previous?: ts.Program,
  { options, hidden, files: extra = new Map() }: Setup = { options: OPTIONS },
) {
  const virtual = new Map(
    Object.entries(files).map(([name, text]) => [join(VIRTUAL, name), text]),
  );
  const served = new Map([...extra, ...virtual]);
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  const seen = (file: string) => !hidden?.test(file);
  host.fileExists = (file) =>
    served.has(file) || (seen(file) && fileExists.call(host, file));
  host.directoryExists = (dir) =>
    [...served.keys()].some((file) => file.startsWith(`${dir}${sep}`)) ||
    (directoryExists?.call(host, dir) ?? true);
  host.readFile = (file) =>
    served.get(file) ?? (seen(file) ? readFile.call(host, file) : undefined);
  host.getSourceFile = (file, language, ...rest) => {
    const text = served.get(file);
    if (text !== undefined) return ts.createSourceFile(file, text, language);
    return seen(file) ? getSourceFile.call(host, file, language, ...rest) : undefined;
  };
  const program = ts.createProgram([...virtual.keys()], options, host, previous);
  const errors = [...virtual.keys()].flatMap((file): string[] => {
    const source = program.getSourceFile(file);
    if (!source) return [`${file} was not loaded`];
    const found = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ];
    return found.map(message);
  });
  const everywhere = () =>
    ts
      .getPreEmitDiagnostics(program)
      .map((error) =>
        error.file
          ? `${relative(ROOT, error.file.fileName)}: ${message(error)}`
          : message(error),
      );
  return { program, errors, everywhere };
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

/** A consumer of the main entry only; a user with no SDK installed at all. */
const USE_MAIN = `
import { CryptoAio, type EvmExt, type EvmFeeDetails, type EvmFeeOverride } from 'crypto-aio';
const aio = new CryptoAio({ env: false });
export const eth = aio.blockchain({ chain: 'ethereum', network: 'sepolia' });
export const ext: EvmExt = eth.ext;
export const fee: EvmFeeOverride = { gasPrice: 1n };
export type Details = EvmFeeDetails;
`;

/** Where the in-memory declaration files live: the `dist` of the tests. */
const DTS = join(ROOT, 'test', 'architecture', '__dts__');

/** The package's declaration files, emitted in memory by the build's own compiler options. */
function declarations(): ReadonlyMap<string, string> {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, 'tsconfig.build.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error('tsconfig.build.json did not parse');
  const options: ts.CompilerOptions = {
    ...config.options,
    outDir: DTS,
    declaration: true,
    emitDeclarationOnly: true,
    sourceMap: false,
    inlineSources: false,
  };
  const out = new Map<string, string>();
  const host = ts.createCompilerHost(options);
  host.writeFile = (file, text) => out.set(file, text);
  const entries = [
    join(ROOT, 'src', 'index.ts'),
    join(ROOT, 'src', 'adapters', 'evm', 'index.ts'),
  ];
  const { diagnostics } = ts.createProgram(entries, options, host).emit();
  expect(diagnostics.map(message)).toEqual([]);
  return out;
}

/**
 * A user with neither SDK installed who type-checks every library file, against the
 * declarations `dist` ships. Mapping `ethers` and `web3` to a missing path in `paths` is not
 * enough (resolution then falls back to node_modules), so the host hides both packages; the
 * control below proves they do not resolve.
 */
const withoutSdks = (dts: ReadonlyMap<string, string>): Setup => ({
  options: {
    ...OPTIONS,
    skipLibCheck: false,
    paths: {
      'crypto-aio': [join(DTS, 'index.d.ts')],
      'crypto-aio/evm': [join(DTS, 'adapters', 'evm', 'index.d.ts')],
    },
  },
  hidden: /[\\/]node_modules[\\/](ethers|web3)[\\/]/,
  files: dts,
});

describe('the main entry names no SDK (spec §5.6)', () => {
  let dts: ReadonlyMap<string, string>;
  beforeAll(() => {
    dts = declarations();
  }, 120_000);

  it('type-checks `crypto-aio` with neither ethers nor web3 resolvable, under skipLibCheck: false', () => {
    const { errors, everywhere } = compile(
      { 'main.ts': USE_MAIN },
      undefined,
      withoutSdks(dts),
    );
    expect(errors).toEqual([]);
    expect(everywhere()).toEqual([]);
  }, 120_000);

  it('control: `crypto-aio/evm` does need the SDK types (R81), so the SDKs really are unresolvable', () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/evm';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/evm\/index\.d\.ts: Cannot find module 'ethers'/,
      ),
      expect.stringMatching(
        /__dts__\/adapters\/evm\/index\.d\.ts: Cannot find module 'web3'/,
      ),
    ]);
  }, 120_000);
});
