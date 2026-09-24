import type { Plugin } from '../registry/plugin';

let builtins: readonly Plugin[] = [];

/** Called by the composition root (`src/index.ts`) to register built-in family plugins. */
export function setBuiltinPlugins(plugins: readonly Plugin[]): void {
  builtins = [...plugins];
}

export function builtinPlugins(): readonly Plugin[] {
  return builtins;
}
