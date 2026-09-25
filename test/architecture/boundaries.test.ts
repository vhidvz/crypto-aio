import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { Blockchain } from '../../src';
import { internalsOf } from '../../src/core/blockchain/internal';
import type { DisposableNativeClient } from '../../src/core/driver/types';
import { native } from '../../src/native';
import { createFakeEnv } from '../../src/testing';

const ROOT = join(__dirname, '..', '..');
const SDK = /^(ethers|web3|tronweb|bitcoinjs-lib|@solana\/|@ton\/)/;
const IMPORT = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*)['"]([^'"]+)['"]/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

const source = (file: string) => readFileSync(file, 'utf8');
const specifiers = (file: string) =>
  [...source(file).matchAll(IMPORT)].map(([, specifier]) => specifier ?? '');

/** The absolute path a relative specifier points at (extension-less); undefined for packages. */
const pointsAt = (file: string, specifier: string) =>
  specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
const within = (path: string | undefined, dir: string) =>
  path !== undefined && (path === dir || path.startsWith(`${dir}${sep}`));

/** Whether `target` is reachable from `root` through own data properties, Map and Set entries. */
function reaches(root: unknown, target: object, seen = new Set<unknown>()): boolean {
  if (root === target) return true;
  if (root === null || (typeof root !== 'object' && typeof root !== 'function')) {
    return false;
  }
  if (seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map) {
    for (const [key, value] of root) {
      if (reaches(key, target, seen) || reaches(value, target, seen)) return true;
    }
  }
  if (root instanceof Set) {
    for (const value of root) if (reaches(value, target, seen)) return true;
  }
  return Reflect.ownKeys(root).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(root, key);
    return descriptor !== undefined && 'value' in descriptor
      ? reaches(descriptor.value, target, seen)
      : false;
  });
}

describe('architecture', () => {
  it('keeps src/core free of adapters, the testing kit and blockchain SDKs', () => {
    const forbidden = [join(ROOT, 'src', 'adapters'), join(ROOT, 'src', 'testing')];
    const offenders: string[] = [];
    for (const file of files(join(ROOT, 'src', 'core'))) {
      for (const specifier of specifiers(file)) {
        const path = pointsAt(file, specifier);
        if (
          SDK.test(specifier) ||
          /^crypto-aio(\/|$)/.test(specifier) ||
          forbidden.some((dir) => within(path, dir))
        ) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never uses dynamic import() expressions in src', () => {
    const offenders = files(join(ROOT, 'src')).filter((file) =>
      /(?<!typeof )\bimport\(/.test(source(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('declares only the allowed runtime dependencies', () => {
    const pkg = JSON.parse(source(join(ROOT, 'package.json'))) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@noble/curves',
      '@noble/hashes',
      '@scure/base',
      '@scure/bip32',
      '@scure/bip39',
      'debug',
    ]);
  });

  it('lets only src/native.ts build or hold native SDK clients', () => {
    const offenders = files(join(ROOT, 'src'))
      .filter((file) => /\.createNativeClient\b|\.nativeClients\b/.test(source(file)))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([join('src', 'native.ts')]);
  });

  it('keeps the native entry point out of every other module, including the other entries', () => {
    const entry = join(ROOT, 'src', 'native');
    const importers = files(join(ROOT, 'src')).filter((file) =>
      specifiers(file).some(
        (specifier) =>
          /^crypto-aio\/native$/.test(specifier) ||
          pointsAt(file, specifier)?.replace(/\.(js|ts)$/, '') === entry,
      ),
    );
    expect(importers.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('architecture: the native escape hatch stays isolated', () => {
  it('builds a client per handle through the driver, never sharing the pooled one', async () => {
    const env = await createFakeEnv();
    const twin = env.aio.blockchain({ chain: env.chainId });
    const pooled = await env.run(internalsOf(env.bc).pooled());
    // Both handles run on the very same pooled driver and transport...
    expect(await env.run(internalsOf(twin).pooled())).toBe(pooled);
    const build = jest.spyOn(
      pooled.driver as { createNativeClient(): DisposableNativeClient },
      'createNativeClient',
    );

    const [mine, concurrent] = await env.run(
      Promise.all([native(env.bc, 'fake-sdk'), native(env.bc, 'fake-sdk')]),
    );
    const again = await env.run(native(env.bc, 'fake-sdk'));
    const theirs = await env.run(native(twin, 'fake-sdk'));

    // ...yet each handle gets its own client, built fresh for it and cached on it alone.
    expect(concurrent).toBe(mine);
    expect(again).toBe(mine);
    expect(theirs).not.toBe(mine);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.results[0]?.value.client).toBe(mine);
    expect(build.mock.results[1]?.value.client).toBe(theirs);
    expect(reaches(pooled, mine)).toBe(false);
    expect(reaches(pooled, theirs)).toBe(false);

    // Mutating one handle's client never reaches another handle.
    (mine.settings as Record<string, unknown>).timeoutMs = 1;
    expect(theirs.settings).toEqual({});
  });

  it("is unreachable from the handle's own API, JSON and inspect", async () => {
    const env = await createFakeEnv();
    const client = await env.run(native(env.bc, 'fake-sdk'));
    const marker = 'NATIVE-CLIENT-MARKER';
    (client.settings as Record<string, unknown>).marker = marker;

    // The handle has no own state at all: its internals live in a module-private WeakMap.
    expect(Object.isFrozen(env.bc)).toBe(true);
    expect(Reflect.ownKeys(env.bc)).toEqual([]);

    const deep = { showHidden: true, showProxy: true, getters: true, depth: Infinity };
    const texts = [JSON.stringify(env.bc), inspect(env.bc, deep)];
    const getters = Object.entries(
      Object.getOwnPropertyDescriptors(Blockchain.prototype),
    ).flatMap(([name, descriptor]) =>
      descriptor.get ? [{ name, get: descriptor.get }] : [],
    );
    expect(getters.map((g) => g.name).sort()).toEqual([
      'capabilities',
      'chain',
      'config',
      'ext',
      'library',
      'network',
    ]);
    for (const { get } of getters) {
      const value: unknown = get.call(env.bc);
      expect(reaches(value, client)).toBe(false);
      texts.push(inspect(value, deep));
    }
    for (const text of texts) expect(text).not.toContain(marker);

    // Family extensions resolve only the driver's `ext` table, never its native-client factory.
    const ext = env.bc.ext as unknown as Record<
      string,
      Record<string, () => Promise<unknown>>
    >;
    await expect(env.run(ext.fake!.createNativeClient!())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});
