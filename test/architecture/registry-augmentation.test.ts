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
    'crypto-aio/tron': [join(ROOT, 'src', 'adapters', 'tron', 'index.ts')],
    'crypto-aio/utxo': [join(ROOT, 'src', 'adapters', 'utxo', 'index.ts')],
    'crypto-aio/solana': [join(ROOT, 'src', 'adapters', 'solana', 'index.ts')],
    'crypto-aio/ton': [join(ROOT, 'src', 'adapters', 'ton', 'index.ts')],
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

/** The UTXO family's chain is typed from the entry; its native client from `crypto-aio/utxo`. */
const USE_UTXO = `
import { CryptoAio, type UtxoFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/utxo';
const aio = new CryptoAio({ env: false });
export const btc = aio.blockchain({ chain: 'bitcoin', network: 'testnet4', library: 'bitcoinjs-lib' });
export const fee: UtxoFeeOverride = { satPerVByte: '1.5' };
export async function tip(): Promise<string> {
  const client = await native(btc, 'bitcoinjs-lib');
  return client.esplora<string>('/blocks/tip/height', 'text');
}
export async function unspent(): Promise<bigint | undefined> {
  return (await btc.ext.utxo.listUnspent('tb1q0')).at(0)?.value;
}
`;

describe('UTXO registry augmentation (R37)', () => {
  it('types the bitcoin chain, networks, library, ext and native client, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'utxo.ts': USE_UTXO,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      { 'acme.ts': USE_ACME, 'utxo.ts': USE_UTXO, 'augment.ts': AUGMENT },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the UTXO family does not have', () => {
    const wrong = USE_UTXO.replace("network: 'testnet4'", "network: 'testnet3'").replace(
      "library: 'bitcoinjs-lib'",
      "library: 'ethers'",
    );
    const { errors } = compile({ 'utxo.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"testnet3"' is not assignable`),
      expect.stringContaining(`'"ethers"' is not assignable`),
    ]);
  }, 120_000);
});

/** The Solana family is typed from the entry; its SDK client from `crypto-aio/solana`. */
const USE_SOLANA = `
import { CryptoAio, type SolanaFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/solana';
const aio = new CryptoAio({ env: false });
export const sol = aio.blockchain({ chain: 'solana', network: 'devnet', library: '@solana/web3.js' });
export const fee: SolanaFeeOverride = { computeUnitPrice: 5n, computeUnitLimit: 20_000n };
// The named override type is a transfer's \`fee\` (Task 12 review M5).
export const paid = () => sol.transfer({ to: 'x', amount: 1n, fee });
export const priced = () => sol.estimateFee({ to: 'x', amount: 1n, fee });
export async function height(): Promise<number> {
  const connection = await native(aio.blockchain({ chain: 'solana' }), '@solana/web3.js');
  return connection.getBlockHeight('confirmed');
}
export async function accounts(): Promise<readonly { readonly amount: bigint }[]> {
  return aio.blockchain({ chain: 'solana', network: 'testnet' }).ext.solana.getTokenAccounts('x');
}
`;

describe('Solana registry augmentation (R37)', () => {
  it('types the Solana chain, networks, library, ext and native client, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'solana.ts': USE_SOLANA,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      { 'acme.ts': USE_ACME, 'solana.ts': USE_SOLANA, 'augment.ts': AUGMENT },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the Solana family does not have', () => {
    const wrong = USE_SOLANA.replace("network: 'devnet'", "network: 'localnet'").replace(
      "library: '@solana/web3.js'",
      "library: 'ethers'",
    );
    const { errors } = compile({ 'solana.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"localnet"' is not assignable`),
      expect.stringContaining(`'"ethers"' is not assignable`),
    ]);
  }, 120_000);
});

/** The TON family's built-in chain is typed from the entry; its SDK client from `crypto-aio/ton`. */
const USE_TON = `
import { CryptoAio, type TonExt, type TonFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/ton';
const aio = new CryptoAio({ env: false });
export const ton = aio.blockchain({ chain: 'ton', network: 'testnet', library: '@ton/ton' });
export const ext: TonExt = ton.ext;
export const fee: TonFeeOverride = { attached: 50_000_000n };
export async function seqno(): Promise<bigint> {
  return ton.ext.ton.getSeqno('0:0000000000000000000000000000000000000000000000000000000000000000');
}
export async function height(): Promise<number> {
  const client = await native(aio.blockchain({ chain: 'ton' }), '@ton/ton');
  return (await client.getMasterchainInfo()).latestSeqno;
}
`;

describe('TON registry augmentation (R37)', () => {
  it('types the TON chain, networks, library, ext and native client next to EVM and a user client, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'ton.ts': USE_TON,
      'evm.ts': USE_EVM,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      {
        'acme.ts': USE_ACME,
        'evm.ts': USE_EVM,
        'ton.ts': USE_TON,
        'augment.ts': AUGMENT,
      },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the TON family does not have', () => {
    const wrong = USE_TON.replace("network: 'testnet'", "network: 'sepolia'").replace(
      "library: '@ton/ton'",
      "library: 'ethers'",
    );
    const { errors } = compile({ 'ton.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"sepolia"' is not assignable`),
      expect.stringContaining(`'"ethers"' is not assignable`),
    ]);
  }, 120_000);
});

/** A consumer of the main entry only; a user with no SDK installed at all. */
const USE_MAIN = `
import { CryptoAio, type EvmExt, type EvmFeeDetails, type EvmFeeOverride } from 'crypto-aio';
import type { UtxoExt, UtxoFeeDetails, UtxoFeeOverride } from 'crypto-aio';
const aio = new CryptoAio({ env: false });
export const eth = aio.blockchain({ chain: 'ethereum', network: 'sepolia' });
export const ext: EvmExt = eth.ext;
export const fee: EvmFeeOverride = { gasPrice: 1n };
export type Details = EvmFeeDetails;
export const btc = aio.blockchain({ chain: 'bitcoin', network: 'signet' });
export const utxo: UtxoExt = btc.ext;
export const satFee: UtxoFeeOverride = { satPerVByte: 2n };
export type SatDetails = UtxoFeeDetails;
import type { TronExt, TronFeeDetails, TronFeeOverride, TronResources } from 'crypto-aio';
export const tron = aio.blockchain({ chain: 'tron', network: 'nile' });
export const tronExt: TronExt = tron.ext;
export const tronFee: TronFeeOverride = { feeLimit: 1n };
export type TronDetails = TronFeeDetails;
export type Resources = TronResources;
import type { OrderingData, TronExpiryOrdering } from 'crypto-aio';
export const tronOrdering: TronExpiryOrdering = {
  kind: 'expiry',
  expiresAtMs: 1,
  lastValidHeight: 65_536n,
  refBlockHash: '00'.repeat(8),
};
export const coreOrdering: OrderingData = tronOrdering;
import type {
  SolanaExpiryOrdering,
  SolanaExt,
  SolanaFeeDetails,
  SolanaFeeOverride,
  SolanaTokenAccount,
} from 'crypto-aio';
export const sol = aio.blockchain({ chain: 'solana', network: 'devnet' });
export const solanaExt: SolanaExt = sol.ext;
export const solanaFee: SolanaFeeOverride = { computeUnitPrice: 1n };
export type SolanaDetails = SolanaFeeDetails;
export type Account = SolanaTokenAccount;
export type Ordering = SolanaExpiryOrdering;
import type { TonExt, TonFeeDetails, TonFeeOverride, TonWalletIdentity } from 'crypto-aio';
export const ton = aio.blockchain({ chain: 'ton', network: 'testnet' });
export const tonExt: TonExt = ton.ext;
export const tonFee: TonFeeOverride = { attached: 1n };
export type TonDetails = TonFeeDetails;
export const wallet: TonWalletIdentity = { version: 'v5r1' };
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
    join(ROOT, 'src', 'adapters', 'tron', 'index.ts'),
    join(ROOT, 'src', 'adapters', 'utxo', 'index.ts'),
    join(ROOT, 'src', 'adapters', 'solana', 'index.ts'),
    join(ROOT, 'src', 'adapters', 'ton', 'index.ts'),
  ];
  const { diagnostics } = ts.createProgram(entries, options, host).emit();
  expect(diagnostics.map(message)).toEqual([]);
  return out;
}

/**
 * A user with no SDK installed who type-checks every library file, against the declarations
 * `dist` ships. Mapping `ethers`, `web3`, `bitcoinjs-lib`, `tronweb`, `@solana/web3.js` and
 * `@ton/*` to a missing path in `paths` is not enough (resolution then falls back to
 * node_modules), so the host hides the packages; the controls below prove they do not
 * resolve.
 */
const withoutSdks = (dts: ReadonlyMap<string, string>): Setup => ({
  options: {
    ...OPTIONS,
    skipLibCheck: false,
    paths: {
      'crypto-aio': [join(DTS, 'index.d.ts')],
      'crypto-aio/evm': [join(DTS, 'adapters', 'evm', 'index.d.ts')],
      'crypto-aio/tron': [join(DTS, 'adapters', 'tron', 'index.d.ts')],
      'crypto-aio/utxo': [join(DTS, 'adapters', 'utxo', 'index.d.ts')],
      'crypto-aio/solana': [join(DTS, 'adapters', 'solana', 'index.d.ts')],
      'crypto-aio/ton': [join(DTS, 'adapters', 'ton', 'index.d.ts')],
    },
  },
  // Every SDK scope: bitcoinjs-lib with its whole dependency scope (its types pull in bip174,
  // valibot and varuint-bitcoin; @noble/hashes is a dependency of this library anyway),
  // tronweb with the packages its types pull in (axios, bignumber.js, eventemitter3, ethers),
  // every `@solana/*` package, not only the SDK, and every `@ton/*` package with every
  // package the three TON SDKs declare (axios, dataloader, zod, jssha, tweetnacl; their types
  // name axios and zod): the main entry needs none of them.
  hidden:
    /[\\/]node_modules[\\/](ethers|web3|bitcoinjs-lib|bip174|valibot|varuint-bitcoin|uint8array-tools|bech32|bs58check|bs58|base-x|tronweb|axios|bignumber\.js|eventemitter3|@solana|@ton|dataloader|zod|jssha|tweetnacl)[\\/]/,
  files: dts,
});

describe('the main entry names no SDK (spec §5.6)', () => {
  let dts: ReadonlyMap<string, string>;
  beforeAll(() => {
    dts = declarations();
  }, 120_000);

  it('hides the whole TON dependency scope: every package the TON SDKs declare', () => {
    const hidden = withoutSdks(new Map()).hidden as RegExp;
    const declared = ['@ton/ton', '@ton/core', '@ton/crypto'].flatMap((sdk) => {
      const pkg = JSON.parse(
        ts.sys.readFile(join(ROOT, 'node_modules', sdk, 'package.json')) ?? '{}',
      ) as { dependencies?: Record<string, string> };
      return [sdk, ...Object.keys(pkg.dependencies ?? {})];
    });
    expect(declared).toEqual(expect.arrayContaining(['axios', 'zod']));
    for (const name of declared) {
      expect([name, hidden.test(join(ROOT, 'node_modules', name, 'index.d.ts'))]).toEqual(
        [name, true],
      );
    }
    for (const kept of ['debug', '@noble/hashes', '@types/node', 'typescript']) {
      expect([kept, hidden.test(join(ROOT, 'node_modules', kept, 'index.d.ts'))]).toEqual(
        [kept, false],
      );
    }
  });

  it('type-checks `crypto-aio` with no SDK resolvable (ethers, web3, bitcoinjs-lib, tronweb, @solana/*, @ton/*), under skipLibCheck: false', () => {
    const { errors, everywhere } = compile(
      { 'main.ts': USE_MAIN },
      undefined,
      withoutSdks(dts),
    );
    expect(errors).toEqual([]);
    expect(everywhere()).toEqual([]);
  }, 120_000);

  it("control: `crypto-aio/tron` does need tronweb's types, so tronweb really is unresolvable", () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/tron';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/tron\/index\.d\.ts: Cannot find module 'tronweb'/,
      ),
    ]);
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

  it('control: `crypto-aio/utxo` does need the bitcoinjs-lib types, so it is unresolvable too', () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/utxo';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/utxo\/sdk\.d\.ts: Cannot find module 'bitcoinjs-lib'/,
      ),
    ]);
  }, 120_000);

  it('control: `crypto-aio/solana` does need the SDK types, so @solana/web3.js really is unresolvable', () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/solana';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/solana\/index\.d\.ts: Cannot find module '@solana\/web3\.js'/,
      ),
    ]);
  }, 120_000);

  it('control: `crypto-aio/ton` does need the SDK types (R81), so @ton/ton really is unresolvable', () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/ton';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/ton\/index\.d\.ts: Cannot find module '@ton\/ton'/,
      ),
    ]);
  }, 120_000);
});

/** The Tron family is typed from the entry; its SDK client from `crypto-aio/tron`. */
const USE_TRON = `
import { CryptoAio, type TronFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/tron';
const aio = new CryptoAio({ env: false });
export const tron = aio.blockchain({ chain: 'tron', network: 'shasta', library: 'tronweb' });
export const fee: TronFeeOverride = { feeLimit: 30_000_000n };
export async function head(): Promise<unknown> {
  const client = await native(aio.blockchain({ chain: 'tron' }), 'tronweb');
  return client.trx.getCurrentBlock();
}
export async function energy(): Promise<bigint> {
  const bc = aio.blockchain({ chain: 'tron', network: 'nile' });
  return (await bc.ext.tron.getResources('T')).energy;
}
`;

describe('Tron registry augmentation (R37)', () => {
  it('types the Tron chain, networks, library, ext and native client, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'tron.ts': USE_TRON,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      { 'acme.ts': USE_ACME, 'tron.ts': USE_TRON, 'augment.ts': AUGMENT },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the Tron family does not have', () => {
    const wrong = USE_TRON.replace("network: 'shasta'", "network: 'goerli'").replace(
      "library: 'tronweb'",
      "library: 'web3'",
    );
    const { errors } = compile({ 'tron.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"goerli"' is not assignable`),
      expect.stringContaining(`'"web3"' is not assignable`),
    ]);
  }, 120_000);
});
