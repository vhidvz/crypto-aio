# Changelog

## Unreleased: 0.1.0

### Security advisory

- Until this release, the repository tracked a `.env` file containing testnet private keys,
  mnemonics and RPC provider tokens. These credentials remain in the git history and must be
  treated as compromised. The file is no longer tracked, and CI now refuses tracked env files
  and scans for secrets.
- The published npm package was not affected: `files: ["/dist"]` never shipped `.env`.
- Owner actions outside this codebase: rotate the provider tokens, move any funds held by
  those keys, and decide whether to rewrite git history.

### Breaking

- The library is being rebuilt as a blockchain abstraction layer. The 0.0.x `CryptoAio`
  (chain getters), `Ethereum`, `Tronix`, `*Account`, `*Contract` and `*Transact` APIs are
  removed. Migration notes are completed with the 0.1.0 release.
