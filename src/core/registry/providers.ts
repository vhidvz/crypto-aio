import { ConfigError } from '../errors/error';
import type { Secret } from '../secret/secret';
import type { EndpointConfig } from '../transport/types';
import { unknownName } from '../util/names';

export interface PresetInput {
  readonly chain: string;
  readonly network: string;
  readonly apiKey?: string | Secret<string>;
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Provider preset contributed by a family plugin. Endpoint URLs holding keys must be `Secret`s. */
export interface ProviderPreset {
  readonly name: string;
  readonly kind: 'rpc' | 'indexer';
  readonly requiresApiKey?: boolean;
  /** `false` for free public endpoints (logged as not for production). */
  readonly production?: boolean;
  supports(chain: string, network: string): boolean;
  endpoints(input: PresetInput): readonly EndpointConfig[];
}

export class PresetCatalog {
  readonly #presets = new Map<string, ProviderPreset[]>();

  /** Several families may contribute presets with the same name (e.g. one per chain family). */
  register(preset: ProviderPreset): void {
    const list = this.#presets.get(preset.name) ?? [];
    list.push(preset);
    this.#presets.set(preset.name, list);
  }

  has(name: string, kind?: 'rpc' | 'indexer'): boolean {
    return (this.#presets.get(name) ?? []).some(
      (p) => kind === undefined || p.kind === kind,
    );
  }

  /** The registered preset names, of one kind or of both. */
  names(kind?: 'rpc' | 'indexer'): string[] {
    return [...this.#presets.keys()].filter((name) => this.has(name, kind));
  }

  resolve(
    name: string,
    input: PresetInput,
    kind: 'rpc' | 'indexer',
  ): { readonly endpoints: readonly EndpointConfig[]; readonly preset: ProviderPreset } {
    const candidates = (this.#presets.get(name) ?? []).filter((p) => p.kind === kind);
    if (candidates.length === 0) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName(`${kind} provider preset`, this.names(kind)),
      );
    }
    const preset = candidates.find((p) => p.supports(input.chain, input.network));
    if (!preset) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `provider preset '${name}' does not support ${input.chain}:${input.network}`,
      );
    }
    if (preset.requiresApiKey && input.apiKey === undefined) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `provider preset '${name}' requires an apiKey`,
      );
    }
    return { endpoints: preset.endpoints(input), preset };
  }

  clone(): PresetCatalog {
    const copy = new PresetCatalog();
    for (const [name, list] of this.#presets) copy.#presets.set(name, [...list]);
    return copy;
  }
}
