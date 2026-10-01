// The capability matrix of docs/reference/capabilities.md matches what the library reports for
// every built-in chain, on every one of its networks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CryptoAio, secret, type ChainId } from '../../src';
import { fakePlugin } from '../../src/testing';

const page = readFileSync(
  join(__dirname, '../../docs/reference/capabilities.md'),
  'utf8',
);

const NETWORKS: Record<string, readonly string[]> = {
  ethereum: ['mainnet', 'sepolia', 'hoodi'],
  bsc: ['mainnet', 'testnet'],
  polygon: ['mainnet', 'amoy'],
  avalanche: ['mainnet', 'fuji'],
  arbitrum: ['mainnet', 'sepolia'],
  optimism: ['mainnet', 'sepolia'],
  base: ['mainnet', 'sepolia'],
  bitcoin: ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'],
  tron: ['mainnet', 'shasta', 'nile'],
  solana: ['mainnet', 'devnet', 'testnet'],
  ton: ['mainnet', 'testnet'],
  'avalanche-x': ['mainnet', 'fuji'],
  'avalanche-p': ['mainnet', 'fuji'],
  fakechain: ['local'],
  fakeexpiry: ['local'],
  fakeseqno: ['local'],
};

/** The matrix: chain → capability → '✓', 'with an indexer' or ''. */
function matrix(): Map<string, Map<string, string>> {
  const rows = page.split('\n').filter((line) => line.startsWith('| `'));
  const header = page.split('\n').find((line) => line.startsWith('| Chain |')) ?? '';
  const columns = header
    .split('|')
    .slice(2, -1)
    .map((cell) => cell.trim().replace(/`/g, ''));
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const chain = /^`([^`]+)`/.exec(cells[0] ?? '')?.[1];
    if (chain === undefined || cells.length !== columns.length + 1) continue;
    out.set(chain, new Map(columns.map((column, i) => [column, cells[i + 1] ?? ''])));
  }
  return out;
}

describe('docs/reference/capabilities.md', () => {
  const endpoint = (name: string, kind?: 'indexer') => ({
    endpoints: [
      { name, url: secret(`https://${name}.example`), ...(kind ? { kind } : {}) },
    ],
  });
  const aio = new CryptoAio({
    env: false,
    plugins: [fakePlugin()],
    providers: { node: endpoint('node'), index: endpoint('index', 'indexer') },
  });
  const table = matrix();
  /** A handle for a chain and network named by the table, as plain strings. */
  const handle = (chain: string, network: string, indexer?: string) =>
    aio.blockchain({
      chain: chain as ChainId,
      network: network as never,
      provider: 'node',
      ...(indexer ? { indexer } : {}),
    });

  it('has a row for every built-in chain', () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(NETWORKS).sort());
  });

  it.each(Object.entries(NETWORKS))('matches %s on every network', (chain, networks) => {
    const row = table.get(chain);
    if (row === undefined) throw new Error(`no row for ${chain}`);
    for (const network of networks) {
      const withIndexer = handle(chain, network, 'index');
      for (const [capability, cell] of row) {
        expect({ network, capability, has: withIndexer.supports(capability) }).toEqual({
          network,
          capability,
          has: cell !== '',
        });
        if (cell === 'with an indexer') {
          const without = handle(chain, network);
          expect({ network, capability, without: without.supports(capability) }).toEqual({
            network,
            capability,
            without: false,
          });
        }
      }
    }
  });
});
