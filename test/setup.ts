// Unit tests never touch the network. Code under test receives an injected fake fetch.
if (process.env.CRYPTO_AIO_INTEGRATION !== '1') {
  globalThis.fetch = (() => {
    throw new Error('Network access is disabled in unit tests; inject a fake fetch');
  }) as unknown as typeof fetch;
}
