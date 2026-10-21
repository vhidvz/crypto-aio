// Packs crypto-aio as `npm publish` would, then checks the tarball as
// a user installs it. Run `pnpm build` first (`pnpm test:pack` does). It needs the npm
// registry, for the package's dependencies and, in the last step, the chain SDKs.
//
// 1. The tarball holds `dist/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`,
//    and nothing else: no source, tests, docs or env files (a `.env` with keys was once
//    committed to the repository).
// 2. Installed without any SDK, every entry point loads, with `require` and with `import`,
//    and each chain family's handle fails with `DEPENDENCY_MISSING` naming its SDK.
// 3. With every SDK at its tested version (the `devDependencies`), each family's adapter
//    loads: `ready()` gets as far as the (unreachable) endpoint.
// 4. The type declarations compile in a TypeScript project that imports every entry point,
//    with the SDKs' own types beside them: on the oldest supported TypeScript (5.3, with
//    `skipLibCheck`, since some SDKs' declarations need 5.7), the tested one and 7, under
//    `nodenext` and `bundler` resolution.
// 5. Every other major line a peer range admits (`^1.99.0 || ^3.0.0`): the family loads
//    with its newest release too, and `native()` hands out its client.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'crypto-aio-pack-'));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const node = (cwd, code, esm = false) =>
  run(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', code], cwd);

const ALLOWED = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/index.js',
];

/** One handle per family; `x` is an endpoint that refuses connections at once. */
const HANDLES = `
const { CryptoAio } = require('crypto-aio');
const url = 'http://127.0.0.1:9';
const aio = new CryptoAio({
  env: false,
  providers: {
    x: { endpoints: [{ name: 'x', url }] },
    xi: { endpoints: [{ name: 'xi', url, kind: 'indexer' }] },
  },
  transport: { timeoutMs: 1000, maxAttempts: 1 },
});
const CASES = [
  ['ethereum', 'sepolia', 'ethers', {}],
  ['bitcoin', 'testnet4', 'bitcoinjs-lib', { indexer: 'xi' }],
  ['tron', 'nile', 'tronweb', {}],
  ['solana', 'devnet', '@solana/web3.js', {}],
  ['ton', 'testnet', '@ton/ton', { indexer: 'xi' }],
  ['avalanche-x', 'fuji', '@avalabs/avalanchejs', { indexer: 'xi' }],
];
async function check(expect) {
  for (const [chain, network, sdk, extra] of CASES) {
    const bc = aio.blockchain({ chain, network, provider: 'x', ...extra });
    const error = await bc.ready().then(() => undefined, (e) => e);
    const missing = error?.code === 'DEPENDENCY_MISSING' && error.message.includes(sdk);
    if (expect === 'missing' ? !missing : error?.code !== 'PROVIDER_UNAVAILABLE') {
      throw new Error(chain + ': expected ' + expect + ', got ' + (error?.code ?? 'no error'));
    }
  }
  await aio.close();
}
`;

try {
  // 1. What npm would publish.
  const [packed] = JSON.parse(
    run(
      'npm',
      ['pack', '--json', '--foreground-scripts=false', '--pack-destination', work],
      root,
    ),
  );
  const files = packed.files.map((file) => file.path);
  const unexpected = files.filter(
    (path) => !path.startsWith('dist/') && !ALLOWED.has(path),
  );
  const missing = REQUIRED.filter((path) => !files.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `tarball: unexpected ${unexpected.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`,
    );
  }
  console.log(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

  // 2. Installed without any SDK.
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true }),
  );
  run('npm', ['install', '--no-audit', '--no-fund', join(work, packed.filename)], app);
  const entries = Object.keys(pkg.exports)
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`));
  node(app, `for (const e of ${JSON.stringify(entries)}) require(e);`);
  node(app, `for (const e of ${JSON.stringify(entries)}) await import(e);`, true);
  console.log(
    `${entries.length} entry points load as CommonJS and as ESM with no SDK installed`,
  );
  node(
    app,
    `${HANDLES}\ncheck('missing').catch((e) => { console.error(e.message); process.exit(1); });`,
  );
  console.log('each family without its SDK fails with DEPENDENCY_MISSING');

  // 3. With every SDK at its tested version.
  const sdks = Object.keys(pkg.peerDependencies).map(
    (name) => `${name}@${pkg.devDependencies[name]}`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', ...sdks], app);
  node(
    app,
    `${HANDLES}\ncheck('loaded').catch((e) => { console.error(e.message); process.exit(1); });`,
  );
  console.log(`each family's adapter loads with ${sdks.join(', ')}`);

  // 4. The declarations, as a TypeScript user compiles them.
  writeFileSync(
    join(app, 'types.ts'),
    `${Object.keys(pkg.exports)
      .filter((key) => key !== './package.json')
      .map((key, i) => {
        const entry = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
        return `import * as entry${i} from '${entry}';`;
      })
      .join('\n')}
import { CryptoAio, type Blockchain } from 'crypto-aio';
const bc: Blockchain<'ethereum'> = new CryptoAio({ env: false }).blockchain({ chain: 'ethereum' });
export const all = [bc, ${Object.keys(pkg.exports)
      .filter((key) => key !== './package.json')
      .map((_, i) => `entry${i}`)
      .join(', ')}];
`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', '@types/node@22'], app);
  for (const [typescript, flags] of [
    ['5.3', ['--skipLibCheck']],
    [pkg.devDependencies.typescript, []],
    ['7', []],
  ]) {
    run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--no-save', `typescript@${typescript}`],
      app,
    );
    for (const resolution of [
      ['--module', 'nodenext', '--moduleResolution', 'nodenext'],
      ['--module', 'esnext', '--moduleResolution', 'bundler'],
    ]) {
      run(
        process.execPath,
        [
          join(app, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'es2022',
          '--types',
          'node',
          ...resolution,
          ...flags,
          'types.ts',
        ],
        app,
      );
    }
    console.log(`the declarations compile with TypeScript ${typescript}`);
  }

  // 5. The newest release of each further major line in a peer range.
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    for (const line of range.split(' || ').slice(1)) {
      const major = line.replace(/^\^/, '').split('.')[0];
      run('npm', ['install', '--no-audit', '--no-fund', `${name}@${major}`], app);
      node(
        app,
        `${HANDLES}
const { native } = require('crypto-aio/native');
check('loaded')
  .then(async () => {
    const [chain, network, , extra] = CASES.find(([, , sdk]) => sdk === ${JSON.stringify(name)});
    // A fresh container: check() closed the first.
    const other = new CryptoAio({
      env: false,
      providers: {
        x: { endpoints: [{ name: 'x', url }] },
        xi: { endpoints: [{ name: 'xi', url, kind: 'indexer' }] },
      },
    });
    const bc = other.blockchain({ chain, network, provider: 'x', ...extra });
    if (!(await native(bc, ${JSON.stringify(name)}))) throw new Error('no native client');
    await other.close();
  })
  .catch((e) => { console.error(e.message); process.exit(1); });`,
      );
      console.log(`the ${name} family loads with ${name}@${major}`);
    }
  }
  console.log('pack check: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
