# Security policy

crypto-aio moves money, so a security report gets priority over every other kind of work.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (once released) | Yes: fixes ship in a patch release of the latest 1.x minor |
| 0.x | Only the latest 0.x minor, until 1.0.0 is released |
| 0.0.x | No: an older, unrelated API |

## Reporting a vulnerability

**Do not open a public issue.** Report it privately instead:

1. Preferred: [GitHub's private vulnerability reporting](https://github.com/vhidvz/crypto-aio/security/advisories/new)
   (the repository's **Security** tab → **Report a vulnerability**).
2. Or email the maintainer at the address in `package.json`'s `author` field, with
   `crypto-aio security` in the subject.

Include the version, the chain family and network, what an attacker controls (an endpoint, an
indexer, a token contract, a signer, the store, the input of a call), and the smallest
reproduction you have. Never include a real private key, mnemonic or API key: a throwaway
testnet key is enough.

You get an acknowledgement within 3 working days, and an assessment within 10. A fix is
released as soon as it is ready; the advisory is published with the release, and credits
you unless you ask otherwise. Please give us 90 days before you disclose a report publicly,
or less if a fix is released sooner.

## What is in scope

Anything that breaks one of the guarantees the documentation makes, for example:

- **Paying twice**, or reporting a transfer as failed when it paid: an idempotency key that
  sends a second payment, a recovery that signs, a verdict that calls a landed transfer
  failed.
- **A wrong verdict**: `final` or `proven` without the finality and the endpoint quorum the
  [evidence rules](https://vhidvz.github.io/crypto-aio/tour/evidence.html) require, or a
  deposit delivered for a block that is not on the chain.
- **A leaked secret**: a private key, a mnemonic, an API key or a credential-bearing URL in an
  error, a log line, an event, a store record or a serialized value.
- **Signing what was not asked**: a signature over different bytes, amounts, recipients or
  fees than the Operation's intent, or a signature without the `beforeSign` hook.
- **A malicious endpoint, indexer or token contract** that can make the library do any of
  the above, or exhaust memory or CPU with a crafted answer.

## What is out of scope

- Bugs in the chain SDKs themselves (report them upstream) and in `crypto-aio/native`, which
  hands you the SDK's own client.
- Durable stores you write yourself; the contract suites in `crypto-aio/testing` describe
  what they must guarantee.
- Losses that follow from a documented limitation, such as trusting a single endpoint after
  configuring only one (see [Known limitations](https://vhidvz.github.io/crypto-aio/reference/limitations.html)).
- A key you also use in other software, which the documentation asks you not to do.

## How releases are protected

Releases are published from GitHub Actions with npm's trusted publishing and provenance:
`npm view crypto-aio --json` shows the provenance of each version, and no npm token exists to
leak. The runtime dependencies are five audited cryptography libraries (`@noble/*`,
`@scure/*`) and `debug`; chain SDKs are optional peers that you install and pin yourself.
