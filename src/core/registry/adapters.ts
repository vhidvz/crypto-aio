import type { AdapterManifest, DriverFactory } from '../driver/types';
import { ConfigError } from '../errors/error';

const keyOf = (m: AdapterManifest): string => `${m.family}/${m.library}`;

function dependencyError(manifest: AdapterManifest, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return error;
  const message = error instanceof Error ? error.message : String(error);
  const named = manifest.peerDependencies.filter(
    (d) => message.includes(`'${d.name}'`) || message.includes(`"${d.name}"`),
  );
  const deps = named.length > 0 ? named : manifest.peerDependencies;
  const install = deps.map((d) => `${d.name}@${d.range}`).join(' ');
  return new ConfigError(
    'DEPENDENCY_MISSING',
    `library '${manifest.library}' (${manifest.family}) needs ${deps.map((d) => d.name).join(', ')}; install it: npm i ${install}`,
    { details: { packages: deps.map((d) => d.name) } },
  );
}

export class AdapterCatalog {
  readonly #manifests = new Map<string, AdapterManifest>();
  readonly #loaded = new Map<string, Promise<DriverFactory>>();

  register(manifest: AdapterManifest): void {
    const key = keyOf(manifest);
    if (this.#manifests.has(key)) {
      throw new ConfigError('CONFIG_INVALID', `adapter '${key}' is already registered`);
    }
    this.#manifests.set(key, manifest);
  }

  /** Manifests for a chain in registration order; the first is the family default. */
  forChain(chainId: string): AdapterManifest[] {
    return [...this.#manifests.values()].filter((m) => m.chains.includes(chainId));
  }

  get(chainId: string, library: string): AdapterManifest | undefined {
    return this.forChain(chainId).find((m) => m.library === library);
  }

  load(manifest: AdapterManifest): Promise<DriverFactory> {
    const key = keyOf(manifest);
    let pending = this.#loaded.get(key);
    if (!pending) {
      pending = manifest.load().catch((error: unknown) => {
        this.#loaded.delete(key);
        throw dependencyError(manifest, error);
      });
      this.#loaded.set(key, pending);
    }
    return pending;
  }

  clone(): AdapterCatalog {
    const copy = new AdapterCatalog();
    for (const [key, manifest] of this.#manifests) copy.#manifests.set(key, manifest);
    return copy;
  }
}
