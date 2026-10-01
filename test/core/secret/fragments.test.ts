import {
  MIN_FRAGMENT_LENGTH,
  createScrubber,
  endpointSecrets,
} from '../../../src/core/secret/fragments';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

describe('endpoint secret fragments (F3-R20)', () => {
  it('derives each path segment, query value, userinfo part and header token', () => {
    const { urls, fragments } = endpointSecrets(
      `https://user:pa55word-long@node.example/v2/${KEY}?api_key=q%2Bvalue%2Fx&flag=1`,
      { authorization: 'Bearer tok_abcdefgh123', 'x-api-key': 'hdr-value-1234' },
    );
    expect(urls).toContain(
      `https://user:pa55word-long@node.example/v2/${KEY}?api_key=q%2Bvalue%2Fx&flag=1`,
    );
    expect(fragments).toEqual(
      expect.arrayContaining([
        KEY,
        'pa55word-long',
        'q%2Bvalue%2Fx',
        'q+value/x',
        'Bearer tok_abcdefgh123',
        'tok_abcdefgh123',
        'hdr-value-1234',
      ]),
    );
  });

  it(`leaves out fragments shorter than ${MIN_FRAGMENT_LENGTH} characters`, () => {
    const { fragments } = endpointSecrets('https://rpc.example/v2/jsonRPC/eth?x=1', {});
    for (const word of ['v2', 'jsonRPC', 'eth', '1', 'user']) {
      expect(fragments).not.toContain(word);
    }
  });

  it('derives the password of a Basic credential', () => {
    const basic = Buffer.from('operator:s3cret-password').toString('base64');
    const { fragments } = endpointSecrets('https://node.example', {
      authorization: `Basic ${basic}`,
    });
    expect(fragments).toEqual(
      expect.arrayContaining([basic, 'operator:s3cret-password', 's3cret-password']),
    );
  });

  it('scrubs every form case-insensitively, the URL as a placeholder, the rest redacted', () => {
    const url = `https://node.example/v2/${KEY}`;
    const scrub = createScrubber('<main>', endpointSecrets(url, {}));
    expect(scrub(`invalid api key ${KEY}`)).toBe('invalid api key [REDACTED]');
    expect(scrub(`invalid api key ${KEY.toLowerCase()}`)).toBe(
      'invalid api key [REDACTED]',
    );
    expect(scrub(`connect ECONNREFUSED ${url}`)).toBe('connect ECONNREFUSED <main>');
    expect(scrub('unknown method eth_foo on v2')).toBe('unknown method eth_foo on v2');
  });

  it('reads a bounded prefix and still removes a secret cut by the limit', () => {
    const scrub = createScrubber(
      '<main>',
      endpointSecrets(`https://n.example/${KEY}`, {}),
    );
    const text = `${'x'.repeat(290)}${KEY}${'y'.repeat(1_000_000)}`;
    const out = scrub(text, 300);
    expect(out).toHaveLength(300);
    expect(out).not.toContain(KEY.slice(0, 10));
    expect(out.startsWith(`${'x'.repeat(290)}[REDACTED]`)).toBe(true);
  });
});
