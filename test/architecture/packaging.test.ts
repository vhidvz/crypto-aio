// The package's entry points, for every family at once: each family adds a subpath, so
// the order rule lives here, not in one family.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  exports: Record<string, unknown>;
  typesVersions: Record<string, Record<string, string[]>>;
};

describe('the package entry points', () => {
  it('lists exports with `.` first, `./package.json` last, and every subpath between sorted', () => {
    const subpaths = Object.keys(pkg.exports);
    expect([subpaths.at(0), subpaths.at(-1)]).toEqual(['.', './package.json']);
    const between = subpaths.slice(1, -1);
    expect(between).toEqual([...between].sort());
  });

  it('keeps typesVersions keys sorted, one per subpath, for resolvers without exports', () => {
    const aliases = Object.keys(pkg.typesVersions['*'] ?? {});
    expect(aliases).toEqual([...aliases].sort());
    const subpaths = Object.keys(pkg.exports).slice(1, -1);
    expect(aliases.map((alias) => `./${alias}`)).toEqual(subpaths);
  });
});
