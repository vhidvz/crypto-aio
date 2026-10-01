import { inspect } from 'node:util';
import { knownName, listNames, unknownName } from '../../../src/core/util/names';
import { createFakeEnv } from '../../../src/testing';

const PASTED = 'pasted-Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('bounded names (F3-R16, F6-R24)', () => {
  it('lists accepted names sorted and unique, counting beyond twelve', () => {
    expect(listNames(['b', 'a', 'b'])).toBe("'a' and 'b'");
    expect(listNames(['c', 'a', 'b'])).toBe("'a', 'b' and 'c'");
    const many = Array.from({ length: 15 }, (_, i) => `n${String(i).padStart(2, '0')}`);
    expect(listNames(many)).toBe(
      "'n00', 'n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10', 'n11' and 3 more",
    );
  });

  it('refuses an unknown name by listing the accepted ones', () => {
    expect(unknownName('wallet', [])).toBe('unknown wallet; none is configured');
    expect(unknownName('option', ['maxFee'])).toBe(
      "unknown option; the only accepted name is 'maxFee'",
    );
    expect(unknownName('network', ['sepolia', 'mainnet'])).toBe(
      "unknown network; the accepted names are 'mainnet' and 'sepolia'",
    );
  });

  it('shows a value only when it is a known fixed word', () => {
    expect(knownName('memo', ['memo', 'tokens'], 'an unknown capability')).toBe("'memo'");
    expect(knownName(PASTED, ['memo'], 'an unknown capability')).toBe(
      'an unknown capability',
    );
    expect(knownName(42, ['memo'], 'an unknown capability')).toBe(
      'an unknown capability',
    );
  });

  it('never repeats a pasted chain, network, library, provider, wallet or signer', async () => {
    const env = await createFakeEnv();
    for (const selection of [
      { chain: PASTED },
      { chain: 'fakechain', network: PASTED },
      { chain: 'fakechain', library: PASTED },
      { chain: 'fakechain', provider: PASTED },
      { chain: 'fakechain', wallet: PASTED },
      { chain: 'fakechain', signer: PASTED },
    ]) {
      const error = thrown(() =>
        env.aio.blockchain(selection as Parameters<typeof env.aio.blockchain>[0]),
      );
      expect(error).toMatchObject({ message: expect.stringMatching(/^unknown /) });
      for (const text of [inspect(error, { depth: 5 }), JSON.stringify(error)]) {
        expect(text).not.toContain(PASTED);
      }
    }
    await expect(env.bc.walletAddress(PASTED)).rejects.toMatchObject({
      message: expect.not.stringContaining(PASTED),
    });
    await expect(env.bc.deriveAddress(PASTED, 0)).rejects.toMatchObject({
      message: expect.not.stringContaining(PASTED),
    });
  });
});
