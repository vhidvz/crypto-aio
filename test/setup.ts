// Unit tests never touch the network. Code under test receives an injected fake fetch.
// The one exception is the local development node of test/integration/evm-local.test.ts:
// with CRYPTO_AIO_IT_EVM_LOCAL_URL set, requests to that URL's origin (and only to it) pass.
if (process.env.CRYPTO_AIO_INTEGRATION !== '1') {
  const local = process.env.CRYPTO_AIO_IT_EVM_LOCAL_URL;
  const origin = local ? new URL(local).origin : undefined;
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (origin !== undefined && URL.canParse(url) && new URL(url).origin === origin) {
      return real(input, init);
    }
    throw new Error('Network access is disabled in unit tests; inject a fake fetch');
  }) as typeof fetch;
}
