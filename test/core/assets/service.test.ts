import { AssetService } from '../../../src/core/assets/service';
import type { ResolvedSelection } from '../../../src/core/config/types';
import type { ChainDriver } from '../../../src/core/driver/types';
import { ProviderError, ValidationError } from '../../../src/core/errors/error';
import type { AssetMetadata, TokenRef } from '../../../src/core/model/asset';
import { createCatalogs } from '../../../src/core/registry/plugin';

const selection = {
  chain: { id: 'acme' },
  network: { id: 'main' },
  capabilities: new Set(['tokens']),
} as unknown as ResolvedSelection;
const token: TokenRef = { standard: 'erc20', contract: '0xToken' };

function serviceWith(lookup: (ref: TokenRef) => Promise<AssetMetadata>) {
  const getTokenMetadata = jest.fn(lookup);
  const driver = { reader: { getTokenMetadata } } as unknown as ChainDriver;
  const catalogs = createCatalogs();
  return { service: new AssetService(() => catalogs), driver, getTokenMetadata };
}

describe('AssetService token metadata cache (N6)', () => {
  it('caches a permanent failure, so a junk token is queried once', async () => {
    const { service, driver, getTokenMetadata } = serviceWith(async () => {
      throw new ValidationError('ASSET_RESOLUTION', 'no decimals');
    });
    for (let i = 0; i < 3; i++) {
      await expect(service.resolve(selection, driver, token)).rejects.toMatchObject({
        code: 'ASSET_RESOLUTION',
      });
    }
    expect(getTokenMetadata).toHaveBeenCalledTimes(1);
  });

  it('drops a retryable failure from the cache and queries again', async () => {
    let calls = 0;
    const { service, driver, getTokenMetadata } = serviceWith(async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
      return { symbol: 'TKN', decimals: 6 };
    });
    await expect(service.resolve(selection, driver, token)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    await expect(service.resolve(selection, driver, token)).resolves.toMatchObject({
      id: 'acme:main/erc20:0xToken',
      metadata: { symbol: 'TKN', decimals: 6 },
    });
    expect(getTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it('drops a non-retryable provider failure from the cache (R53: only ASSET_RESOLUTION is cached)', async () => {
    let calls = 0;
    const { service, driver, getTokenMetadata } = serviceWith(async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError('RPC_ERROR', 'method not allowed');
      return { symbol: 'TKN', decimals: 6 };
    });
    await expect(service.resolve(selection, driver, token)).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
    });
    await expect(service.resolve(selection, driver, token)).resolves.toMatchObject({
      metadata: { symbol: 'TKN', decimals: 6 },
    });
    expect(getTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it('drops a retryable ASSET_RESOLUTION failure from the cache', async () => {
    let calls = 0;
    const { service, driver, getTokenMetadata } = serviceWith(async () => {
      calls += 1;
      if (calls === 1)
        throw new ValidationError('ASSET_RESOLUTION', 'decimals unreadable for now', {
          retryable: true,
        });
      return { symbol: 'TKN', decimals: 6 };
    });
    await expect(service.resolve(selection, driver, token)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: true,
    });
    await expect(service.resolve(selection, driver, token)).resolves.toMatchObject({
      metadata: { symbol: 'TKN', decimals: 6 },
    });
    expect(getTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it('drops a foreign (non crypto-aio) failure from the cache', async () => {
    const { service, driver, getTokenMetadata } = serviceWith(async () => {
      throw new TypeError('driver bug');
    });
    await expect(service.resolve(selection, driver, token)).rejects.toThrow('driver bug');
    await expect(service.resolve(selection, driver, token)).rejects.toThrow('driver bug');
    expect(getTokenMetadata).toHaveBeenCalledTimes(2);
  });
});
