---
title: Keys, signers and secrets
parent: Build
nav_order: 9
description: Local and callback signers, the beforeSign policy hook, secrets and redaction, and the native escape hatch.
---

# Keys, signers and secrets

Private keys live **only inside signers**. The domain model, the handle, events, logs and
stores never hold key material. This guide covers the two built-in signers, the policy hook,
how secrets are redacted, what the stores hold, and the escape hatch to the SDK.

## Local signers

`localSigner` keeps keys in memory, in private fields that are never serialized. A curve
gives schemes: `secp256k1` gives `secp256k1-ecdsa` and `secp256k1-schnorr`, and `ed25519`
gives `ed25519`.

```ts
import { localSigner, secret } from 'crypto-aio';

// Generate new keys; share the public keys, never the signer.
const { signer, publicKeys } = localSigner.generate({ curves: ['secp256k1'], id: 'hot-1' });

// Import an existing key (32 bytes, hex or Uint8Array), always wrapped in a Secret.
const imported = localSigner({ id: 'hot-2', secp256k1: secret(process.env.HOT_KEY_HEX ?? '') });

// BIP39 mnemonic: BIP32 for secp256k1, SLIP-10 for ed25519. The path comes from the wallet.
const hd = localSigner.fromMnemonic(secret(process.env.MNEMONIC ?? ''), { id: 'hd' });
const wallets = { treasury: { signer: 'hd', keyRef: { path: "m/44'/60'/0'/0/0" } } };
```

**TON keys.** TON wallet apps such as Tonkeeper use TON's own 24-word mnemonics, which are
not BIP39: `localSigner.fromMnemonic` derives a different key from them. Import the 32-byte
ed25519 seed instead, `localSigner({ id: 'ton-hot', ed25519: secret(seedHex) })`: it is the
first 32 bytes of the 64-byte `secretKey` that `mnemonicToPrivateKey` from `@ton/crypto`
returns. A wrong key shows up as a wallet address that differs from the one your wallet
app shows, so compare them before you fund or send.

**Give each TON wallet to crypto-aio alone.** Never share its key with other software: a
wallet app, a script, another service, or another crypto-aio namespace. Anything else that
holds the key can use the wallet's seqnos, so your transfers end `replaced`, and it can
empty and delete the wallet, which anyone can then deploy again with its seqno back at 0.
A reset during a transfer's lifetime, or in the 5 minutes before its build, leaves the
library unable to prove that the transfer did not land, so it stays undecided rather than
risk a second payment. Before the library sends a transfer's signed bytes again (a retry, a
rebroadcast or a recovery), it checks the wallet's chain and withholds them while a reset
cannot be ruled out ([TON resends](../reference/networks/ton.md)). No client can stop anyone
else from sending them again: after a reset, a message that already ran can run a second
time while it is valid, and anyone who saw it can send it.

Prefer a TON key generated for the service to one imported from a wallet app: generate it
once, keep its 32-byte seed in your secret store or KMS, and import it at startup with
`localSigner({ id, ed25519: secret(seedHex) })`, or use a custody `callbackSigner`. A key
from `localSigner.generate` lives only in memory, so a wallet funded from it is lost on
restart unless you exported its seed. If you import a key from a wallet app, stop sending
from that wallet in the app.

Keys can leave a signer in only one way: `exportKey`, on a signer created with
`exportable: true` (`generate`, `localSigner` and `fromMnemonic` all accept it). It returns a
`Secret<Uint8Array>`. On any other signer it throws `SigningError` with
`KEY_NOT_EXPORTABLE`. Leave `exportable` off in production.

```ts
const { signer: backup } = localSigner.generate({ curves: ['ed25519'], exportable: true });
const key = await backup.exportKey?.('ed25519'); // Secret<Uint8Array>
```

## Callback signers: HSM, KMS, MPC and remote custody

`callbackSigner` wraps any custody system in three callbacks. The core sends signing
requests (`{ id, scheme, payload, payloadKind, publicKey, keyRef? }`) and a `SigningContext`
(`operationId`, `namespace`, `chain`, `network`, `wallet`, `tier`, `purpose`, `summary`,
`fee` and `unsignedHash`). It never sends secrets or SDK objects.

```ts
import { callbackSigner } from 'crypto-aio';

const custody = callbackSigner({
  id: 'mpc-1',
  schemes: ['secp256k1-ecdsa'],
  getPublicKey: async (scheme, keyRef) => vault.publicKey(scheme, keyRef?.id),
  sign: async (requests, ctx) => {
    const ticket = await vault.submit(requests, { reference: ctx.operationId });
    return { status: 'pending', ticket }; // or { status: 'signed', signatures }
  },
  cancelRequest: async (ticket) => vault.cancel(ticket), // used by abandon()
});
```

- **Signed now:** return `{ status: 'signed', signatures: [{ requestId, bytes, recovery? }] }`.
  For `secp256k1-ecdsa`, `bytes` is the 64-byte compact r‖s with low s, plus `recovery`
  0 or 1. The core checks the result shape and verifies every signature against the
  request's public key before it assembles anything. A bad result gives `SIGNING_FAILED` or
  `SIGNATURE_MISMATCH`.
- **Signed later:** return `{ status: 'pending', ticket }`. The Operation waits in
  `awaiting-signature` with its nonce reserved. When custody finishes, call
  `bc.submitSignatures(operationId, signatures)`. `bc.abandon(operationId)` cancels every
  pending ticket through the signer that issued it.
- **Time limit:** `lifecycle.signTimeoutMs` (default 120 s) bounds the hook and the signer.
  On timeout nothing is written: the Operation stays `prepared`, and a repeat asks again.
  Custody that needs longer should answer `pending`.
- **Late completion:** if custody signs after you abandoned the Operation, the nonce may
  already be reused. At most one of the two transactions can land. The monitor reports the
  other one as `replaced`.
- **Errors** from your callbacks become `SIGNING_FAILED` with a sanitized cause. URLs and
  credentials in a custody error message never reach logs.
- A wallet can route requests to several signers by `keyRef.id`:
  `{ signers: { 'key-a': 'mpc-1', 'key-b': 'hsm-2' } }`.

## The `beforeSign` policy hook

`hooks.beforeSign(ctx)` runs once before each signing round, not once per `SigningRequest`:
one call covers every request of that round. Throw from it to veto. The veto becomes
`POLICY_REJECTED`. On a first signing, the Operation fails before anything is signed, and its
nonce is released. On a replace, cancel or rebuild, only the new Attempt is refused, and the
existing one stays live.

```ts
const aio = new CryptoAio({
  hooks: {
    beforeSign: async (ctx) => {
      // ctx.summary: { asset, outputs: [{ to, amount /* base units, as a string */ }], memo? }
      const verdict = await policy.check(ctx.operationId, ctx.wallet, ctx.tier, ctx.summary);
      if (!verdict.approved) throw new Error(verdict.reason);
    },
  },
  // …
});
```

- **It may run more than once per Operation.** It runs once per concurrent caller, again
  when a `prepared` Operation is repeated, again in `submitSignatures`, and for replace,
  cancel and rebuild (see `ctx.purpose`). Key your checks on `ctx.operationId` so that they
  are idempotent.
- **Keep it short.** It runs while the wallet's address lease is held, and
  `lifecycle.signTimeoutMs` bounds it in every call, `prepareTransfer` included. A timeout
  (`TIMEOUT`, retryable) writes nothing: the Operation stays `prepared`, and a repeat asks
  the hook again. `transfer` and `submitSignatures` keep the lease alive meanwhile, but
  `prepareTransfer` does not. There, a hook that outlasts `lifecycle.leaseMs` can lose the
  lease to another transfer, and its veto then writes nothing.
- **Business policy stays outside the adapters.** Withdrawal limits, approvals, treasury
  rules and accounting belong in your application. The hook is the seam. A wallet's `tier`
  is metadata that is passed to the hook, and the library gives it no built-in meaning.

## Secrets and redaction

`secret(value)` wraps a credential. `String()`, `JSON.stringify` and `util.inspect` show
`[REDACTED]`, and only `reveal()` returns the value. Wrap every API key, credentialed URL and
private key in a `Secret`. Redaction happens in these places:

| Where | What happens |
| --- | --- |
| Provider URLs | A `Secret` URL shows as `https://host/[REDACTED]`. In a plain URL, user info, query values and key-like path segments (16 or more characters) are redacted |
| Headers | `Secret` values, and headers named like `authorization`, `api-key`, `token`, `secret` or `cookie` |
| Errors | Transport errors name the endpoint (`<provider/endpoint>`), never its URL. Every part of an endpoint's configuration a provider may echo back is removed from error messages, `details` and causes, in any letter case: a key in a path segment, a query value, a header value or the token after an auth scheme (as `[REDACTED]`, for parts of 8 characters or more, and whole URLs and header values of any length). A REST error names the route template, such as `GET /address/:address/txs`, never the path with its address or txid. Signer failures carry a sanitized cause |
| `bc.config` | A frozen, redacted snapshot of the resolved configuration |
| Events | Operational data only: no URLs, addresses, amounts, raw transactions or signatures |
| Logs | `createLogger` redacts URLs in messages, and fields named like `key`, `secret`, `token`, `password`, `passphrase`, `mnemonic`, `private`, `seed`, `authorization` or `cookie` |
| Environment | `CRYPTO_AIO_…_RPC_URL` and `…_INDEXER_URL` are wrapped as secrets; the environment never supplies keys |

`redactUrl(url)` and `redactDeep(value)` are exported for your own logging. Log a library
error by its `code`, or by `error.toJSON()`, which leaves out the cause chain.

An error never repeats a name you typed that the library does not know: a chain, network,
library, provider, wallet, signer, signature scheme, asset alias, option key or capability.
It lists the names it accepts instead (`unknown wallet; the accepted names are 'cold' and
'hot'`), so a secret pasted into the wrong field never reaches a message or a log.

## The native escape hatch (`crypto-aio/native`)

```ts
import { native } from 'crypto-aio/native';

const client = await native(env.bc, 'fake-sdk'); // native(eth, 'ethers'), native(tron, 'tronweb')
```

- Each handle gets **its own** SDK client, built on the first call. Later calls on the same
  handle return the same client. Another handle, even one from `with()`, gets another client.
  It is never the pooled instance the drivers use, so you can change it freely.
- It is typed through `NativeClientMap`, which each adapter augments. The library name must
  match the handle's (`INCOMPATIBLE_SELECTION` otherwise). A driver without a native client
  throws `UNSUPPORTED_CAPABILITY`.
- On EVM, `native(bc, 'ethers')` returns an ethers `JsonRpcApiProvider` and
  `native(bc, 'web3')` a `Web3` instance, both wired to the handle's transport, so they never
  see the real URL. Import `crypto-aio/evm` once to type them. Its declarations name both
  SDKs' types, so with only one SDK installed, keep `skipLibCheck: true` (the `tsc --init`
  default) or install the other SDK too.
- On Tron, `native(bc, 'tronweb')` returns a `TronWeb` instance whose full node, solidity
  node and event server all send through the handle's transport, so it never sees the real
  URL or the TronGrid key. Import `crypto-aio/tron` once to type it; with
  `skipLibCheck: false`, that needs tronweb installed.
- On TON, `native(bc, '@ton/ton')` returns a `TonClient` for toncenter's API v2 whose
  requests go through the handle's transport, so it never sees the real URL or the key.
  Import `crypto-aio/ton` once to type it. Its `send*` methods are broadcasts: a send that
  fails may still have been delivered, so treat it as sent until the chain shows otherwise.
  Errors that `@ton/ton` raises itself may carry the node's whole answer.
- **An SDK's own errors are not scrubbed.** The client never sees the real URL or key, but
  an error the SDK raises itself may quote the provider's answer, and a provider may echo
  your key in it. Log a native client's errors by type or code, not by message.
- The root container's `close()` closes every native client handed out, once, then the
  driver pool. A client that fails to close is logged by error code only. After that,
  `native()` and the handle's methods throw `INVALID_TRANSITION`.
- It is **outside the stable API**. It is not covered by semver, and the SDK's behaviour is
  yours to manage.

## Next steps

- [Cold and asynchronous signing](./cold-signing.md): sign outside the process.
- [Go to production](./production.md): the key and secret items of the checklist.
- [Secrets and key custody](../learn/engineering/secrets.md): the ideas behind this guide.
