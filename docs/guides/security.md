---
summary: Signers, the beforeSign policy hook, secrets and redaction, data classification, the native escape hatch, and a production checklist.
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
A reset during a transfer's lifetime leaves the library unable to prove that the transfer
did not land, so it stays undecided rather than risk a second payment. Before the library
sends a transfer's signed bytes again (a retry, a rebroadcast or a recovery), it checks the
wallet's chain and withholds them while a reset cannot be ruled out
([TON resends](./networks.md#ton-networks)). No client can stop anyone else from sending
them again: after a reset, a message that already ran can run a second time while it is
valid, and anyone who saw it can send it. Prefer a key
generated for the service (`localSigner.generate({ curves: ['ed25519'] })`) to one imported
from a wallet app, and if you import one, stop sending from that wallet in the app.

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
| Errors | Transport errors name the endpoint (`<provider/endpoint>`), never its URL. A REST error's text may carry the request path, such as an address or a txid, but never the host or a credential. Signer failures carry a sanitized cause |
| `bc.config` | A frozen, redacted snapshot of the resolved configuration |
| Events | Operational data only: no URLs, addresses, amounts, raw transactions or signatures |
| Logs | `createLogger` redacts URLs in messages, and fields named like `key`, `secret`, `token`, `password`, `passphrase`, `mnemonic`, `private`, `seed`, `authorization` or `cookie` |
| Environment | `CRYPTO_AIO_…_RPC_URL` and `…_INDEXER_URL` are wrapped as secrets; the environment never supplies keys |

`redactUrl(url)` and `redactDeep(value)` are exported for your own logging. Log a library
error by its `code`, or by `error.toJSON()`, which leaves out the cause chain.

## Data classification (for store implementers)

The core never hands key material to a store. It classifies everything else it persists in
`DATA_CLASSIFICATION`, field by field, for Operations, Attempts and observations. Backing
stores can then encrypt and retain data per field.

| Class | Examples | Handling |
| --- | --- | --- |
| `secret` | none; the core never persists secrets | n/a |
| `sensitive` | intent (addresses, amounts, memo, output variants), unsigned payload, context, idempotency key, reservation and Attempt ordering, signer tickets, partial signatures, fees, errors, an observation's `reason` (a node's refusal text or the driver's on-chain failure reason) | Encrypt at rest |
| `sensitive-until-broadcast` | Attempt `raw` bytes and `ref` | Public once broadcast; before that they reveal pending treasury activity |
| `operational` | ids, states, versions, claims, timestamps, heights, hashes | Safe for telemetry |

An Operation's `reservation` and an Attempt's `ordering` are `sensitive`, because an `inputs`
ordering lists UTXO outpoints, which tie a wallet to its coins. A nonce or seqno value on its
own is operational, and the `nonce.allocated` and `nonce.gap` events carry it.

- Store plain data only: objects, arrays, strings, numbers, booleans, `bigint` and
  `Uint8Array`. `stringifyTagged` and `parseTagged` round-trip bigint and bytes through JSON.
- Keep keys out of store error messages. Sequence keys contain wallet addresses, and error
  messages reach logs.
- The core never deletes records. `OperationStore.purge?(filter)` is optional, and retention
  is your decision.
- Prove your stores with the contract suites from `crypto-aio/testing`. See
  [Using any blockchain network](./networks.md#testing-an-adapter-or-a-store).

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
- The root container's `close()` closes every native client handed out, once, then the
  driver pool. A client that fails to close is logged by error code only. After that,
  `native()` and the handle's methods throw `INVALID_TRANSITION`.
- It is **outside the stable API**. It is not covered by semver, and the SDK's behaviour is
  yours to manage.

## Bitcoin safeguards

On Bitcoin, a wrong fee or change address burns funds, and an Esplora endpoint is trusted
for what it reports. The driver's guards:

- **Absurd fees.** A fee above `options.maxFeeRate` (1,000 sat/vB) or `options.maxFee`
  (0.1 BTC) fails with `INVALID_INTENT`, on every transfer, replacement and cancel,
  explicit overrides included. A fee estimate above `options.maxEstimatedFeeRate`
  (200 sat/vB) is not trusted, so one endpoint cannot set an absurd rate.
- **Change address.** Every transaction's change goes to `wallet.utxo.changeAddress` when it
  is set, so it must be an address the wallet's own key or `xpub` derives. Any other
  address fails with `CONFIG_INVALID`. `wallet.utxo.allowExternalChangeAddress: true` lifts
  that check for a change address of another key, such as a cold wallet's. With it, a
  mistyped but valid address loses every change output, so set it only for an address you
  have verified. A cancel always pays back to the sending address.
- **Input values.** Before anything is signed, each new input's previous transaction must
  be in a block the proof endpoints attest (except the wallet's own sent transactions under
  `minInputConfirmations: 0`), and every input's value and script are checked against that
  transaction, whose bytes must hash to the input's txid. So the indexer can neither
  misstate what you spend nor invent a coin for you to spend. Keep `options.nonWitnessUtxo` on (the default)
  for hardware signers: each `p2pkh` and segwit v0 input then carries that transaction in
  the PSBT, so the signer can check the fee itself. A `p2tr` input never carries it; its
  signature commits to every input's amount.
- **Endpoints.** With a single Esplora endpoint as the `provider`, its operator alone decides
  finality and whether a transfer was replaced. Use two independent endpoints, ideally
  three. A node's claim that your transaction is invalid ends a transfer only when the
  driver confirms it for the bytes it sent, so a lying endpoint cannot free your coins for a
  second payment. It can still refuse to relay them, which several endpoints and
  `lifecycle.broadcastFanout` of 2 or more route around.

See [Bitcoin networks](./networks.md#bitcoin-networks) for the defaults and how a refused
transfer resolves.

## Solana safeguards

On Solana, one endpoint's answers set a transfer's price and compute limit, and a proof
decides whether a transfer can be sent again. The driver's guards:

- **Priority fee.** The compute-unit price is at most
  `chains.solana.options.maxComputeUnitPrice` (10,000,000 micro-lamports per compute unit by
  default, `DEFAULT_MAX_COMPUTE_UNIT_PRICE`), which no endpoint can raise. A speed is
  clamped below it, an override above it fails with `INVALID_INTENT` before signing (naming
  the option, with `details.required` and `details.maxComputeUnitPrice`), and the build
  checks it again. With the limit at its 1,400,000-unit maximum, the default bound caps a
  transfer's priority fee at 0.014 SOL, so one lying endpoint cannot spend the wallet. Any
  other key in `chains.solana.options` fails with `CONFIG_INVALID`. For a tighter policy per
  transfer, compare `ctx.fee` in `beforeSign`.
- **Proof providers.** A proof that a transfer never landed is what lets `rebuild` sign a
  new one, so a wrong one pays twice. Each proof is a quorum over your endpoints: use two or
  three independent keyed or self-hosted providers. The `public` preset's rate limits let it
  prove absence only slowly, over many passes, so a transfer that never landed stays
  unresolved for minutes there.
- **A refusal is not a failure.** A `stalled` transfer (`TX_REFUSED`, `INSUFFICIENT_FUNDS`)
  may still land until its blockhash's window has passed. Retry only with
  `bc.rebroadcast(id)` or by repeating the call with the same idempotency key, never as a
  new transfer. A node's claim that the signature is invalid ends a transfer only when the
  driver confirms it for the bytes it sent.
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unmodified, `blockhash` included: a changed blockhash misplaces the expiry proof's window
  ([why](./networks.md#testing-an-adapter-or-a-store)).
- **The native client.** `native(bc, '@solana/web3.js')` returns a `Connection` wired to the
  handle's transport, so it never sees the real URL or key. It speaks HTTP JSON-RPC only
  (no subscriptions), and it parses numbers itself, so values above 2^53 are rounded there;
  the driver's own reads keep u64 amounts exact. Import `crypto-aio/solana` once to type it;
  with `skipLibCheck: false`, that needs `@solana/web3.js` installed.

See [Solana networks](./networks.md#solana-networks) for the defaults, how a refused
transfer resolves, and which addresses a scan filter matches.

## Production checklist

- [ ] One `new CryptoAio({ namespace })` per tenant. Scopes are not tenant boundaries.
- [ ] `lifecycle.requireIdempotencyKey: true`, with keys taken from durable business records.
- [ ] Durable, shared stores (operations, locks, sequences, cursors) that pass the contract
      suites. The memory stores are for tests and single processes.
- [ ] `sensitive` fields encrypted at rest, with a retention policy.
- [ ] Custody signers (`callbackSigner`) for significant balances. No `exportable` keys. No
      keys in config files or source control. Every credential in a `Secret`.
- [ ] An idempotent, short `beforeSign` hook in front of your own policy engine.
- [ ] At least two independent providers per network, so proofs are cross-checked. No
      `public` preset in production.
- [ ] Tron: memos are public forever and cost a fee; never put personal data in one. Use the
      `trongrid` preset with a key on mainnet (keyless TronGrid fails there), next to a
      second, independent provider.
- [ ] `await bc.ready()` at startup, to fail fast on a missing SDK or a misconfigured provider.
- [ ] `aio.operations.recover()` at startup, then `aio.monitor.start()` workers. Alerts on
      `operation.stalled`, `nonce.gap`, `recovery.skipped` and `provider.misconfigured`.
- [ ] Credit and complete only on `final` with `proven` evidence. Dedupe deposits on the
      transfer id. On Bitcoin, skip a transfer whose `to` is among its `from` addresses
      (change, a cancel's refund), and never use a scanned deposit address as a change
      address.
- [ ] `await aio.close()` on shutdown.
- [ ] Bitcoin: your own Esplora, with two or three independent endpoints as the `provider`;
      `lifecycle.broadcastFanout` of 2 or more; `nonWitnessUtxo` left on for hardware
      signers; and `allowExternalChangeAddress` only for a verified address.
- [ ] Solana: two or three independent keyed or self-hosted providers; `maxComputeUnitPrice`
      set to your fee policy; a store that keeps each Attempt's `ordering` whole; after a
      refusal, retry only with `rebroadcast` or the same idempotency key; credit SPL
      deposits by the owner wallet (`transfer.to`).
- [ ] TON: two or three independent toncenter-compatible pairs (`provider` and `indexer`),
      archival where they serve proofs, with a key on toncenter, never the `public` preset;
      wallets whose keys nothing else holds; a store that keeps each Attempt's `ordering`
      (`TonSeqnoOrdering`, `validFrom` included) exactly; and jetton deposits credited only
      from the arrival in the owner's jetton wallet's history, never from the owner's
      notification, deduped on that transfer id, not on the trace id.
