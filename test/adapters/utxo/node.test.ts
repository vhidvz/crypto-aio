// The scripted Esplora node must model bitcoind's rules exactly (lesson 8): it is what the
// safety tests of the driver and the core run against.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { walletAddress } from '../../../src/adapters/utxo/address';
import {
  SEQUENCE_RBF,
  assembleTx,
  buildTx,
  networkOf,
  type PlannedInput,
} from '../../../src/adapters/utxo/codec';
import { classifyBroadcast, parseNodeError } from '../../../src/adapters/utxo/errors';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import type { UtxoAddressType } from '../../../src/adapters/utxo/types';
import { tweakPrivateKey } from '../../../src/core/signing/local';
import type { SignatureBundle } from '../../../src/core/signing/types';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { FakeClock } from '../../../src/testing/fake-clock';
import { hang } from '../../../src/testing/fake-fetch';
import {
  ScriptedEsploraNode,
  assertModelled,
  type ScriptedEsploraNodeOptions,
} from './support/node';
import {
  malleate,
  nativeSigner,
  signedLegacySpend,
  signedSpend,
  type Malleation,
} from './support/tx';
import { OTHER_PUBKEY, REGTEST, TEST_KEY, TEST_PUBKEY } from './support/vectors';

const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE_WALLET = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = PAYEE_WALLET.script;
const NETWORK = networkOf(REGTEST);
const OP_TRUE = Uint8Array.of(0x51);

function setup(options: Omit<Partial<ScriptedEsploraNodeOptions>, 'clock'> = {}) {
  const node = new ScriptedEsploraNode({ clock: new FakeClock(), ...options });
  const base = node.endpoint('a');
  const [txid] = node.fund(OWN.address, 100_000n).split(':') as [string];
  const get = async (path: string) => {
    const response = await node.fetch.fetch(`${base}${path}`);
    return { status: response.status, text: await response.text() };
  };
  const post = async (hex: string) => {
    const response = await node.fetch.fetch(`${base}/tx`, { method: 'POST', body: hex });
    return { status: response.status, text: await response.text() };
  };
  const spend = (value: bigint, sequence?: number) =>
    signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE, value]], sequence);
  return { node, base, txid, get, post, spend };
}

const idOf = (hex: string) => bitcoin.Transaction.fromHex(hex).getId();
const json = (reply: { text: string }) =>
  JSON.parse(reply.text) as Record<string, unknown>;
const refusal = (code: number, text: string) =>
  `sendrawtransaction RPC error ${code}: ${text}`;

/** A script failure as bitcoind words it: `CScriptCheck` names the input and what it spends. */
function scriptRefusal(reason: string, hex: string, index = 0): string {
  const tx = bitcoin.Transaction.fromHex(hex);
  const input = tx.ins[index]!;
  const prev = toHex(Uint8Array.from(input.hash).reverse());
  const wtxid = toHex(Uint8Array.from(tx.getHash(true)).reverse());
  return `${reason}, input ${index} of ${tx.getId()} (wtxid ${wtxid}), spending ${prev}:${input.index}`;
}

const SIG_NULLFAIL = 'Signature must be zero for failed CHECK(MULTI)SIG operation';
const EVAL_FALSE =
  'Script evaluated without error but finished with a false/empty top stack element';

/** A transaction edited after signing (only for checks that run before the scripts). */
function edited(
  hex: string,
  edit: (tx: InstanceType<typeof bitcoin.Transaction>) => void,
) {
  const tx = bitcoin.Transaction.fromHex(hex);
  edit(tx);
  return tx.toHex();
}

/** A spend of `txid:0` (100,000 sat) paying `fee`, padded with an OP_RETURN to `vsize`. */
function paddedSpend(txid: string, fee: bigint, vsize: number): string {
  let size = Math.max(0, vsize - 130);
  for (let tries = 0; tries < 50; tries++) {
    const hex = signedSpend(
      TEST_KEY,
      [[txid, 0, 100_000n]],
      [
        [PAYEE, 100_000n - fee],
        [bitcoin.script.compile([0x6a, new Uint8Array(size).fill(0x2a)]), 0n],
      ],
    );
    const got = bitcoin.Transaction.fromHex(hex).virtualSize();
    if (got === vsize) return hex;
    size = Math.max(
      0,
      size + Math.sign(vsize - got) * Math.max(1, Math.abs(vsize - got) - 1),
    );
  }
  throw new Error(`no padding gives ${vsize} vB`);
}

/** A p2wpkh spend of TEST_KEY's outputs with a chosen lock time and version. */
function lockedSpend(
  inputs: readonly (readonly [string, number, bigint])[],
  outputs: readonly (readonly [Uint8Array, bigint])[],
  options: { readonly locktime?: number; readonly sequence?: number } = {},
): string {
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.setLocktime(options.locktime ?? 0);
  for (const [txid, vout, value] of inputs) {
    psbt.addInput({
      hash: txid,
      index: vout,
      sequence: options.sequence ?? SEQUENCE_RBF,
      witnessUtxo: { script: OWN.script, value },
    });
  }
  for (const [script, value] of outputs) psbt.addOutput({ script, value });
  psbt.signAllInputs(nativeSigner(TEST_KEY));
  psbt.finalizeAllInputs();
  return psbt.extractTransaction(true).toHex();
}

/**
 * What the real codec assembles for a wallet type (Task 5): two funded inputs, a payment and
 * change, signed like the core's local signer.
 */
function codecSpend(node: ScriptedEsploraNode, type: UtxoAddressType) {
  const wallet = walletAddress(TEST_PUBKEY, type, REGTEST);
  const inputs: PlannedInput[] = [50_000n, 70_000n].map((value) => {
    const [txid] = node.fund(wallet.address, value).split(':') as [string];
    return {
      outpoint: `${txid}:0`,
      txid,
      vout: 0,
      value,
      prevTxHex: node.transaction(txid)!.toHex(),
    };
  });
  const outputs = [
    { script: PAYEE, value: 100_000n },
    { script: wallet.script, value: 19_000n },
  ];
  const built = buildTx(NETWORK, wallet, inputs, outputs, SEQUENCE_RBF);
  const requests = built.digests.map((digest, index) => ({
    id: `in:${index}`,
    scheme:
      type === 'p2tr' ? ('secp256k1-schnorr' as const) : ('secp256k1-ecdsa' as const),
    payload: digest,
    payloadKind: 'digest' as const,
    publicKey: type === 'p2tr' ? (wallet.outputKey as Uint8Array) : wallet.publicKey,
    ...(wallet.tweak ? { params: { tweak: wallet.tweak } } : {}),
  }));
  const signatures: SignatureBundle[] = requests.map((request) =>
    request.scheme === 'secp256k1-schnorr'
      ? {
          requestId: request.id,
          bytes: schnorr.sign(
            request.payload,
            tweakPrivateKey(TEST_KEY, wallet.tweak as Uint8Array),
            new Uint8Array(32),
          ),
        }
      : {
          requestId: request.id,
          bytes: secp256k1
            .sign(request.payload, TEST_KEY, { lowS: true })
            .toCompactRawBytes(),
        },
  );
  return assembleTx(built.psbt, NETWORK, requests, signatures);
}

/** The first input's signature with one bit of `r` flipped (still strict DER). */
function forged(hex: string, type: UtxoAddressType): string {
  return edited(hex, (tx) => {
    const input = tx.ins[0]!;
    if (type === 'p2pkh') {
      const [sig, key] = bitcoin.script.decompile(input.script) as [
        Uint8Array,
        Uint8Array,
      ];
      const bad = Uint8Array.from(sig);
      bad[10] = bad[10]! ^ 1;
      tx.setInputScript(0, bitcoin.script.compile([bad, key]));
    } else {
      const witness = input.witness.map((item) => Uint8Array.from(item));
      witness[0]![10] = witness[0]![10]! ^ 1;
      tx.setWitness(0, witness);
    }
  });
}

describe('ScriptedEsploraNode', () => {
  it('serves the chain: genesis, tip, blocks, transactions and unknown ids as Esplora does', async () => {
    const { node, txid, get } = setup();
    expect((await get('/block-height/0')).text).toBe(node.options.genesisHash);
    expect((await get('/blocks/tip/height')).text).toBe('1');
    expect(JSON.parse((await get(`/tx/${txid}`)).text)).toMatchObject({
      txid,
      status: { confirmed: true, block_height: 1 },
    });
    expect(await get(`/tx/${'ab'.repeat(32)}`)).toEqual({
      status: 404,
      text: 'Transaction not found',
    });
    // Esplora's /status answers `confirmed: false` for a transaction it does not know.
    expect(JSON.parse((await get(`/tx/${'ab'.repeat(32)}/status`)).text)).toEqual({
      confirmed: false,
    });
    expect((await get('/block-height/9')).status).toBe(404);
  });

  it('accepts a valid spend and re-announces it when sent again', async () => {
    const { node, post, spend } = setup();
    const hex = spend(90_000n);
    expect(await post(hex)).toEqual({ status: 200, text: idOf(hex) });
    expect(await post(hex)).toEqual({ status: 200, text: idOf(hex) });
    node.mine();
    expect(await post(hex)).toEqual({
      status: 400,
      text: 'sendrawtransaction RPC error -27: Transaction outputs already in utxo set',
    });
  });

  it('refuses a spend of an output spent in a block, and junk bytes', async () => {
    const { node, post, spend } = setup();
    await post(spend(90_000n));
    node.mine();
    expect((await post(spend(80_000n))).text).toBe(
      'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent',
    );
    expect((await post('00')).text).toContain('-22: TX decode failed');
  });

  it('applies the replacement rules of Bitcoin Core 28-30', async () => {
    const { node, post, spend } = setup({ incrementalRelayFee: 1_000n });
    const first = spend(99_000n); // 1,000 sat
    await post(first);
    // A lower absolute fee.
    expect((await post(spend(99_500n))).text).toMatch(
      /-26: insufficient fee, rejecting replacement/,
    );
    // Higher, but not by the incremental relay fee for its size.
    expect((await post(spend(98_990n))).text).toMatch(
      /not enough additional fees to relay/,
    );
    const second = spend(98_000n);
    expect(await post(second)).toEqual({ status: 200, text: idOf(second) });
    expect(node.inMempool(idOf(first))).toBe(false);
  });

  it('honours BIP125 signalling when full RBF is off', async () => {
    const { post, spend } = setup({ fullRbf: false });
    await post(spend(99_000n, 0xffffffff));
    expect((await post(spend(90_000n))).text).toBe(
      'sendrawtransaction RPC error -26: txn-mempool-conflict',
    );
  });

  it('checks the relay fee, dust and every signature, in either error format', async () => {
    const { post, spend } = setup({ errorFormat: 'mempool' });
    expect((await post(spend(99_990n))).text).toBe(
      'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 10 < 11"}',
    );
    // Bitcoin Core 29+ (ephemeral dust): one dust output is standard only in a 0-fee transaction.
    expect((await post(spend(200n))).text).toContain(
      '"message":"dust, tx with dust output must be 0-fee"',
    );
    const forgedTx = bitcoin.Transaction.fromHex(spend(90_000n));
    const witness = forgedTx.ins[0]!.witness;
    witness[0] = Uint8Array.from(witness[0]!);
    witness[0][10] = witness[0][10]! ^ 1;
    // Bitcoin Core 30 checks scripts once, with the standard flags.
    expect((await post(forgedTx.toHex())).text).toBe(
      `sendrawtransaction RPC error: ${JSON.stringify({
        code: -26,
        message: scriptRefusal(
          `mempool-script-verify-flag-failed (${SIG_NULLFAIL})`,
          forgedTx.toHex(),
        ),
      })}`,
    );
  });

  it('reorgs blocks back into the mempool, evicts on request and hides blocks from a lagging endpoint', async () => {
    const { node, post, spend, get } = setup();
    const hex = spend(90_000n);
    await post(hex);
    node.mine();
    node.reorg(1);
    expect(node.inMempool(idOf(hex))).toBe(true);
    node.evict(idOf(hex));
    expect(node.inMempool(idOf(hex))).toBe(false);
    node.mine(3);
    node.setLag('a', 2);
    expect((await get('/blocks/tip/height')).text).toBe(String(node.height - 2));
    expect(() => node.reorg(node.height + 1)).toThrow();
  });

  it('shows a transaction confirmed above a lagging view as in its mempool (I1)', async () => {
    const { node, post, spend, get, txid } = setup();
    const hex = spend(90_000n);
    await post(hex);
    node.mine();
    node.setLag('a', 1);
    expect(JSON.parse((await get(`/tx/${idOf(hex)}`)).text).status).toEqual({
      confirmed: false,
    });
    expect(JSON.parse((await get(`/tx/${txid}/outspend/0`)).text)).toEqual({
      spent: true,
      txid: idOf(hex),
      vin: 0,
      status: { confirmed: false },
    });
    // A block reward never entered a mempool: hidden above the view.
    const [coinbase] = node.blockTxids(node.height);
    expect((await get(`/tx/${coinbase}`)).status).toBe(404);
    node.setLag('a', 0);
    expect(JSON.parse((await get(`/tx/${idOf(hex)}`)).text).status).toMatchObject({
      confirmed: true,
    });
  });

  it("refuses non-standard p2pkh signatures into the mempool, but a miner's block takes them (M7)", async () => {
    const { node, post } = setup();
    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const [txid] = node.fund(legacy.address, 100_000n).split(':') as [string];
    const prev = node.transaction(txid)!.toHex();
    const ours = signedLegacySpend(TEST_KEY, [[txid, 0, prev]], [[PAYEE, 90_000n]]);
    const refusals: [Malleation, string][] = [
      [
        'high-s',
        'mempool-script-verify-flag-failed (Non-canonical signature: S value is unnecessarily high)',
      ],
      [
        'pushdata1',
        'mempool-script-verify-flag-failed (Data push larger than necessary)',
      ],
      [
        'junk-push',
        'mempool-script-verify-flag-failed (Stack size must be exactly one after execution)',
      ],
      ['op-nop', 'scriptsig-not-pushonly'],
    ];
    for (const [kind, text] of refusals) {
      const copy = malleate(ours, kind);
      expect((await post(copy)).text).toBe(
        refusal(-26, kind === 'op-nop' ? text : scriptRefusal(text, copy)),
      );
    }
    const copy = malleate(ours, 'high-s');
    node.mine(1, { extra: [copy] });
    expect(node.confirmations(idOf(copy))).toBe(1);
  });

  it('re-adds a disconnected transaction with the fee limits bypassed (M7)', async () => {
    const { node, post, spend } = setup();
    const hex = spend(99_900n); // 100 sat: fine at the default minimum
    await post(hex);
    node.mine();
    node.setMempoolMinFee(50_000n);
    node.reorg(1);
    expect(node.inMempool(idOf(hex))).toBe(true);
  });
});

describe('what the real codec produces (Task 5)', () => {
  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const)(
    '%s: accepts the assembled spend and verifies every signature',
    async (type) => {
      const { node, post } = setup();
      const spent = codecSpend(node, type);
      const failure = type === 'p2tr' ? 'Invalid Schnorr signature' : SIG_NULLFAIL;
      const bad = forged(spent.hex, type);
      expect((await post(bad)).text).toBe(
        refusal(
          -26,
          scriptRefusal(`mempool-script-verify-flag-failed (${failure})`, bad),
        ),
      );
      expect(await post(spent.hex)).toEqual({ status: 200, text: spent.txid });
      if (type !== 'p2pkh') {
        // Another witness of a txid already in the mempool is re-announced, as bitcoind does.
        expect(await post(forged(spent.hex, type))).toEqual({
          status: 200,
          text: spent.txid,
        });
      }
      node.mine();
      expect(node.confirmations(spent.txid)).toBe(1);
    },
  );

  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const)(
    '%s: checks again with the consensus flags under legacyScriptErrors (Bitcoin Core 29)',
    async (type) => {
      const { node, post } = setup({ legacyScriptErrors: true });
      const spent = codecSpend(node, type);
      const bad = forged(spent.hex, type);
      // A consensus failure reports the second check's error.
      const failure = type === 'p2tr' ? 'Invalid Schnorr signature' : EVAL_FALSE;
      expect((await post(bad)).text).toBe(
        refusal(
          -26,
          scriptRefusal(`mandatory-script-verify-flag-failed (${failure})`, bad),
        ),
      );
      if (type === 'p2pkh') {
        const high = malleate(spent.hex, 'high-s');
        expect((await post(high)).text).toBe(
          refusal(
            -26,
            scriptRefusal(
              'non-mandatory-script-verify-flag (Non-canonical signature: S value is unnecessarily high)',
              high,
            ),
          ),
        );
      }
    },
  );

  it.each(['blockstream', 'mempool'] as const)(
    '%s: a consensus-invalid signature is refused on v30 and rejected on v29, through the classifier',
    async (errorFormat) => {
      // The transport keeps 300 characters of a 4xx body (details.body).
      const classify = (body: string) =>
        classifyBroadcast(parseNodeError(body.slice(0, 300)));
      const v30 = setup({ errorFormat });
      const bad30 = forged(codecSpend(v30.node, 'p2wpkh').hex, 'p2wpkh');
      const body30 = (await v30.post(bad30)).text;
      expect(body30.length).toBeGreaterThan(300);
      expect(classify(body30)).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'the node refused the transaction',
      });
      const v29 = setup({ errorFormat, legacyScriptErrors: true });
      const bad29 = forged(codecSpend(v29.node, 'p2wpkh').hex, 'p2wpkh');
      const body29 = (await v29.post(bad29)).text;
      expect(body29.length).toBeGreaterThan(300);
      expect(classify(body29)).toEqual({
        kind: 'rejected',
        reason: 'script verification failed',
      });
    },
  );
});

describe("bitcoind's checks, in bitcoind's order", () => {
  it('decodes strictly: plain hex only, either case', async () => {
    const { post, spend } = setup();
    const hex = spend(90_000n);
    const decodeFailed = refusal(
      -22,
      'TX decode failed. Make sure the tx has at least one input.',
    );
    expect((await post(`${hex}\n`)).text).toBe(decodeFailed);
    expect((await post(`0x${hex}`)).text).toBe(decodeFailed);
    expect((await post(`${hex}00`)).text).toBe(decodeFailed);
    expect((await post('')).text).toBe(decodeFailed);
    expect(await post(hex.toUpperCase())).toEqual({ status: 200, text: idOf(hex) });
  });

  it('runs CheckTransaction first', async () => {
    const { post, spend, txid } = setup();
    const base = spend(90_000n);
    const cases: [string, string][] = [
      [
        edited(base, (tx) => tx.addInput(fromHex(txid).reverse(), 0, 0xfffffffd)),
        'bad-txns-inputs-duplicate',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.value = -1n;
        }),
        'bad-txns-vout-negative',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.value = 2_100_000_000_000_001n;
        }),
        'bad-txns-vout-toolarge',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.value = 2_000_000_000_000_000n;
          tx.addOutput(PAYEE, 200_000_000_000_000n);
        }),
        'bad-txns-txouttotal-toolarge',
      ],
      [
        edited(base, (tx) => tx.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff)),
        'bad-txns-prevout-null',
      ],
    ];
    for (const [hex, reason] of cases)
      expect((await post(hex)).text).toBe(refusal(-26, reason));
    const coinbase = (script: Uint8Array) => {
      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, script);
      tx.addOutput(PAYEE, 1_000n);
      return tx.toHex();
    };
    expect((await post(coinbase(Uint8Array.of(0x51, 0x51)))).text).toBe(
      refusal(-26, 'coinbase'),
    );
    expect((await post(coinbase(Uint8Array.of(0x51)))).text).toBe(
      refusal(-26, 'bad-cb-length'),
    );
  });

  it('applies standardness before looking at the inputs', async () => {
    const { node, post, spend, txid } = setup();
    const base = spend(90_000n);
    const cases: [string, string][] = [
      [
        edited(base, (tx) => {
          tx.version = 4;
        }),
        'version',
      ],
      [
        edited(base, (tx) => {
          tx.version = 0;
        }),
        'version',
      ],
      [
        edited(base, (tx) =>
          tx.setInputScript(0, Uint8Array.of(0x4d, 0x70, 0x06, ...new Uint8Array(1648))),
        ),
        'scriptsig-size',
      ],
      [
        edited(base, (tx) => tx.setInputScript(0, Uint8Array.of(0x61))),
        'scriptsig-not-pushonly',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.script = OP_TRUE;
        }),
        'scriptpubkey',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.value = 200n;
          tx.addOutput(PAYEE, 200n);
        }),
        'dust',
      ],
      [
        edited(base, (tx) => {
          tx.outs[0]!.script = Uint8Array.of(0x6a);
          tx.outs[0]!.value = 0n;
        }),
        'tx-size-small',
      ],
      // Standardness refuses before the (missing) inputs are looked up.
      [
        edited(base, (tx) => {
          tx.addInput(new Uint8Array(32).fill(7), 0);
          tx.outs[0]!.value = 100n;
          tx.addOutput(PAYEE, 100n);
        }),
        'dust',
      ],
    ];
    for (const [hex, reason] of cases)
      expect((await post(hex)).text).toBe(refusal(-26, reason));
    // Version 3 (TRUC) has its own topology rules, which this node does not model: it says so.
    expect(() =>
      node.submit(
        edited(base, (tx) => {
          tx.version = 3;
        }),
      ),
    ).toThrow(/TRUC/);
    // An unspendable output with value is refused before anything else (maxburnamount 0).
    expect(
      (
        await post(
          signedSpend(
            TEST_KEY,
            [[txid, 0, 100_000n]],
            [
              [PAYEE, 90_000n],
              [Uint8Array.of(0x6a, 0x01, 0x2a), 1n],
            ],
          ),
        )
      ).text,
    ).toBe(
      refusal(
        -25,
        'Unspendable output exceeds maximum configured by user (maxburnamount)',
      ),
    );
  });

  it('checks finality, relative lock times, coinbase maturity and input values', async () => {
    const { node, post, spend, txid } = setup();
    expect(
      (
        await post(
          lockedSpend([[txid, 0, 100_000n]], [[PAYEE, 99_000n]], { locktime: 2 }),
        )
      ).text,
    ).toBe(refusal(-26, 'non-final'));
    // BIP68: 3 blocks after the funding block (height 1).
    const relative = lockedSpend([[txid, 0, 100_000n]], [[PAYEE, 99_000n]], {
      sequence: 3,
    });
    expect((await post(relative)).text).toBe(refusal(-26, 'non-BIP68-final'));
    node.mine();
    expect((await post(relative)).text).toBe(refusal(-26, 'non-BIP68-final'));
    const above = edited(spend(90_000n), (tx) => {
      tx.outs[0]!.value = 100_001n;
    });
    expect((await post(above)).text).toBe(
      refusal(-26, 'bad-txns-in-belowout, value in (0.001) < value out (0.00100001)'),
    );
    node.mine();
    expect(await post(relative)).toEqual({ status: 200, text: idOf(relative) });
    node.evict(idOf(relative));
    expect(
      await post(
        lockedSpend([[txid, 0, 100_000n]], [[PAYEE, 99_000n]], {
          locktime: node.height,
        }),
      ),
    ).toMatchObject({ status: 200 });

    // A block reward (paid to an anyone-can-spend p2wsh) matures after 100 blocks.
    const [coinbase] = node.blockTxids(1) as [string];
    const reward = node.transaction(coinbase)!.outs[0]!.value;
    const spendReward = new bitcoin.Transaction();
    spendReward.version = 2;
    spendReward.addInput(fromHex(coinbase).reverse(), 0, 0xfffffffd);
    spendReward.addOutput(PAYEE, reward - 1_000n);
    spendReward.setWitness(0, [OP_TRUE]);
    expect((await post(spendReward.toHex())).text).toBe(
      refusal(
        -26,
        'bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 3',
      ),
    );
    node.mine(96);
    expect((await post(spendReward.toHex())).text).toBe(
      refusal(
        -26,
        'bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 99',
      ),
    );
    node.mine();
    expect(await post(spendReward.toHex())).toMatchObject({ status: 200 });
  });

  it('refuses non-standard inputs and witnesses, which a block still takes', async () => {
    const { node, post, txid } = setup();
    const bare = signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[OP_TRUE, 99_000n]]);
    expect((await post(bare)).text).toBe(refusal(-26, 'scriptpubkey'));
    node.mine(1, { extra: [bare] });
    const spendBare = new bitcoin.Transaction();
    spendBare.version = 2;
    spendBare.addInput(fromHex(idOf(bare)).reverse(), 0, 0xfffffffd);
    spendBare.addOutput(PAYEE, 98_000n);
    expect((await post(spendBare.toHex())).text).toBe(
      refusal(-26, 'bad-txns-nonstandard-inputs'),
    );
    node.mine(1, { extra: [spendBare.toHex()] });
    expect(node.confirmations(spendBare.getId())).toBe(1);

    const legacy = walletAddress(TEST_PUBKEY, 'p2pkh', REGTEST);
    const [funded] = node.fund(legacy.address, 50_000n).split(':') as [string];
    const prev = node.transaction(funded)!.toHex();
    const stuffed = edited(
      signedLegacySpend(TEST_KEY, [[funded, 0, prev]], [[PAYEE, 49_000n]]),
      (tx) => tx.setWitness(0, [Uint8Array.of(1)]),
    );
    expect((await post(stuffed)).text).toBe(refusal(-26, 'bad-witness-nonstandard'));
  });

  it("refuses an absurd fee with bitcoind's maxfeerate, after every other check", async () => {
    const { node, post, get } = setup();
    const [big] = node.fund(OWN.address, 100_000_000n).split(':') as [string];
    const absurd = signedSpend(TEST_KEY, [[big, 0, 100_000_000n]], [[PAYEE, 1_000n]]);
    expect((await post(absurd)).text).toBe(
      refusal(-25, 'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)'),
    );
    // It had passed AcceptToMemoryPool: the refusal still leaves no trace.
    expect(node.inMempool(idOf(absurd))).toBe(false);
    expect(json(await get(`/tx/${big}/outspend/0`))).toEqual({ spent: false });
  });
});

describe('mempool policy', () => {
  it('applies the dynamic mempool minimum after the relay minimum', async () => {
    const { node, post, spend } = setup();
    node.setMempoolMinFee(5_000n);
    // 100 sat for 110 vB: above the 11 sat relay minimum, below 5 sat/vB.
    expect((await post(spend(99_900n))).text).toBe(
      refusal(-26, 'mempool min fee not met, 100 < 550'),
    );
  });

  it('prints the replacement refusals as bitcoind does', async () => {
    const { node, post, spend, txid } = setup({ incrementalRelayFee: 1_000n });
    const first = spend(99_000n);
    expect(bitcoin.Transaction.fromHex(first).virtualSize()).toBe(110);
    await post(first);
    const lower = spend(99_500n);
    expect((await post(lower)).text).toBe(
      refusal(
        -26,
        `insufficient fee, rejecting replacement ${idOf(lower)}; new feerate 0.00004545 BTC/kvB <= old feerate 0.00009090 BTC/kvB`,
      ),
    );
    const thin = spend(98_990n);
    expect((await post(thin)).text).toBe(
      refusal(
        -26,
        `insufficient fee, rejecting replacement ${idOf(thin)}, not enough additional fees to relay; 0.0000001 < 0.0000011`,
      ),
    );
    // A smaller transaction: a higher rate, but less in absolute fees (rule 3).
    const wide = signedSpend(
      TEST_KEY,
      [[txid, 0, 100_000n]],
      [
        [PAYEE, 90_000n],
        [OWN.script, 9_000n],
      ],
    );
    node.evict(idOf(first));
    await post(wide);
    const small = spend(99_100n);
    expect((await post(small)).text).toBe(
      refusal(
        -26,
        `insufficient fee, rejecting replacement ${idOf(small)}, less fees than conflicting txs; 0.000009 < 0.00001`,
      ),
    );
    // Rule 2: no new unconfirmed input.
    const [pending] = node.fund(OWN.address, 50_000n, { mempool: true }).split(':') as [
      string,
    ];
    const adds = signedSpend(
      TEST_KEY,
      [
        [txid, 0, 100_000n],
        [pending, 0, 50_000n],
      ],
      [[PAYEE, 140_000n]],
    );
    expect((await post(adds)).text).toBe(
      refusal(
        -26,
        `replacement-adds-unconfirmed, replacement ${idOf(adds)} adds unconfirmed input, idx 1`,
      ),
    );
    // A transaction that spends an output of the transaction it replaces.
    const both = signedSpend(
      TEST_KEY,
      [
        [txid, 0, 100_000n],
        [idOf(wide), 1, 9_000n],
      ],
      [[PAYEE, 100_000n]],
    );
    expect((await post(both)).text).toBe(
      refusal(
        -26,
        `bad-txns-spends-conflicting-tx, ${idOf(both)} spends conflicting transaction ${idOf(wide)}`,
      ),
    );
    expect(node.inMempool(idOf(wide))).toBe(true);
  });

  it.each([false, true])(
    'compares fee rates exactly (v30), or as truncated sat/kvB (v29, truncatedFeeRates %s)',
    async (truncatedFeeRates) => {
      const { post, spend, txid } = setup({ truncatedFeeRates });
      // 901 sat for 141 vB and 703 sat for 110 vB: 6.3901 and 6.3909 sat/vB, both 6,390 sat/kvB.
      const original = signedSpend(
        TEST_KEY,
        [[txid, 0, 100_000n]],
        [
          [PAYEE, 90_000n],
          [OWN.script, 9_099n],
        ],
      );
      const replacement = spend(99_297n);
      expect(bitcoin.Transaction.fromHex(original).virtualSize()).toBe(141);
      expect(bitcoin.Transaction.fromHex(replacement).virtualSize()).toBe(110);
      await post(original);
      // v30 compares exactly: a higher rate, so rule 3 (the absolute fee) refuses it.
      expect((await post(replacement)).text).toBe(
        refusal(
          -26,
          truncatedFeeRates
            ? `insufficient fee, rejecting replacement ${idOf(replacement)}; new feerate 0.00006390 BTC/kvB <= old feerate 0.00006390 BTC/kvB`
            : `insufficient fee, rejecting replacement ${idOf(replacement)}, less fees than conflicting txs; 0.00000703 < 0.00000901`,
        ),
      );
    },
  );

  it.each([false, true])(
    'accepts 10,046 sat for 1,999 vB over 1,000 sat for 199 vB on v30 only (truncatedFeeRates %s)',
    async (truncatedFeeRates) => {
      const { post, txid } = setup({ truncatedFeeRates });
      // 5.02512 and 5.02551 sat/vB: both 5,025 sat/kvB when truncated.
      const original = paddedSpend(txid, 1_000n, 199);
      const replacement = paddedSpend(txid, 10_046n, 1_999);
      expect(await post(original)).toMatchObject({ status: 200 });
      expect((await post(replacement)).text).toBe(
        truncatedFeeRates
          ? refusal(
              -26,
              `insufficient fee, rejecting replacement ${idOf(replacement)}; new feerate 0.00005025 BTC/kvB <= old feerate 0.00005025 BTC/kvB`,
            )
          : idOf(replacement),
      );
    },
  );

  it('refuses a replacement of more than 100 transactions (rule 5)', async () => {
    const { node, post } = setup();
    const [big] = node.fund(OWN.address, 10_100_000n).split(':') as [string];
    const fan = signedSpend(
      TEST_KEY,
      [[big, 0, 10_100_000n]],
      Array.from({ length: 101 }, () => [OWN.script, 99_000n] as const),
    );
    node.submit(fan);
    node.mine();
    const outs = Array.from({ length: 101 }, (_, i) => [idOf(fan), i, 99_000n] as const);
    for (const input of outs)
      node.submit(signedSpend(TEST_KEY, [input], [[PAYEE, 98_800n]]));
    const all = signedSpend(TEST_KEY, outs, [[PAYEE, 101n * 99_000n - 30_000n]]);
    expect((await post(all)).text).toBe(
      refusal(
        -26,
        `too many potential replacements, rejecting replacement ${idOf(all)}; too many potential replacements (101 > 100)`,
      ),
    );
  });

  it('limits unconfirmed chains to 25 transactions', async () => {
    const { node, post } = setup();
    let [prev] = node.fund(OWN.address, 1_000_000n).split(':') as [string];
    let value = 1_000_000n;
    for (let i = 0; i < 25; i++) {
      const hex = signedSpend(TEST_KEY, [[prev, 0, value]], [[OWN.script, value - 200n]]);
      prev = node.submit(hex);
      value -= 200n;
    }
    const last = signedSpend(TEST_KEY, [[prev, 0, value]], [[PAYEE, value - 200n]]);
    expect((await post(last)).text).toBe(
      refusal(-26, 'too-long-mempool-chain, too many unconfirmed ancestors [limit: 25]'),
    );
  });
});

describe('atomic application and immutable records', () => {
  it('leaves no trace of a refused transaction, even across a reorg', async () => {
    const { node, post, spend, get, txid } = setup();
    const first = spend(99_000n);
    await post(first);
    // It passes every replacement rule, then fails its signature: nothing may change.
    const bad = forged(spend(95_000n), 'p2wpkh');
    expect((await post(bad)).text).toContain('mempool-script-verify-flag-failed');
    expect(node.inMempool(idOf(first))).toBe(true);
    expect(json(await get(`/tx/${txid}/outspend/0`))).toMatchObject({
      txid: idOf(first),
    });
    expect((await get(`/tx/${idOf(bad)}`)).status).toBe(404);
    // A block whose first transaction evicts `first` and whose second is invalid.
    const height = node.height;
    expect(() => node.mine(1, { extra: [spend(80_000n), bad] })).toThrow(/invalid block/);
    expect(node.height).toBe(height);
    expect(node.inMempool(idOf(first))).toBe(true);
    node.mine();
    node.reorg(1);
    expect(node.inMempool(idOf(first))).toBe(true);
    expect(node.inMempool(idOf(bad))).toBe(false);
    expect(json(await get(`/tx/${txid}/outspend/0`))).toMatchObject({
      txid: idOf(first),
    });
  });

  it('never rewrites a block or transaction already served', async () => {
    const { node, post, spend, get } = setup();
    const hex = spend(90_000n);
    await post(hex);
    const [hash] = node.mine() as [string];
    const paths = [`/block/${hash}`, `/block/${hash}/txs`, `/tx/${idOf(hex)}/hex`];
    const before = await Promise.all(paths.map(get));
    node.fund(OWN.address, 5_000n);
    node.fund(OWN.address, 6_000n, { mempool: true });
    node.mine(2);
    const copy = node.transaction(idOf(hex))!;
    copy.outs[0]!.value = 1n;
    copy.ins[0]!.witness[0]![5] = 0;
    expect(await Promise.all(paths.map(get))).toEqual(before);
    expect(node.transaction(idOf(hex))!.toHex()).toBe(hex);
  });

  it('keeps what electrs keeps of a disconnected block, and drops its descendants', async () => {
    const { node, post, get, txid } = setup();
    const parent = signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[OWN.script, 99_000n]]);
    await post(parent);
    const [stale] = node.mine() as [string];
    const child = signedSpend(TEST_KEY, [[idOf(parent), 0, 99_000n]], [[PAYEE, 98_000n]]);
    await post(child);
    node.reorg(1, { drop: [idOf(parent)] });
    expect(node.inMempool(idOf(child))).toBe(false);
    const [fresh] = node.mine() as [string];
    expect(fresh).not.toBe(stale);
    expect((await get(`/block/${stale}`)).status).toBe(404);
    // electrs' txstore is append-only: a stale block's txids and transactions stay readable.
    expect(JSON.parse((await get(`/block/${stale}/txids`)).text)).toContain(idOf(parent));
    // Blockstream's electrs checks a block's header before paging its transactions.
    expect(await get(`/block/${stale}/txs`)).toEqual({
      status: 404,
      text: 'Block not found',
    });
    expect(json(await get(`/tx/${idOf(parent)}`)).status).toEqual({ confirmed: false });
    expect(json(await get(`/tx/${txid}/outspend/0`))).toEqual({ spent: false });
    // An electrs in light mode reads transactions from bitcoind by their confirming block.
    const light = node.endpoint('light', { lightMode: true });
    expect((await node.fetch.fetch(`${light}/tx/${idOf(parent)}`)).status).toBe(404);
    expect((await node.fetch.fetch(`${light}/block/${stale}/txids`)).status).toBe(200);
    const tip = node.blockTxids(node.height);
    expect(() => node.reorg(1, { drop: ['ab'.repeat(32)] })).toThrow();
    expect(node.blockTxids(node.height)).toEqual(tip);
    expect(() => node.evict('ab'.repeat(32))).toThrow();
  });
});

describe('scripted faults', () => {
  it("shows a lagging view the mempool it had before a miner's double spend", async () => {
    const { node, post, spend, get, txid } = setup();
    const ours = spend(90_000n);
    await post(ours);
    const theirs = spend(80_000n);
    node.mine(1, { extra: [theirs] });
    expect(node.inMempool(idOf(ours))).toBe(false);
    node.setLag('a', 1);
    expect(json(await get(`/tx/${idOf(ours)}`)).status).toEqual({ confirmed: false });
    expect((await get(`/tx/${idOf(theirs)}`)).status).toBe(404);
    expect(json(await get(`/tx/${txid}/outspend/0`))).toMatchObject({
      txid: idOf(ours),
      status: { confirmed: false },
    });
    node.setLag('a', 0);
    expect((await get(`/tx/${idOf(ours)}`)).status).toBe(404);
    expect(json(await get(`/tx/${txid}/outspend/0`))).toMatchObject({
      txid: idOf(theirs),
      status: { confirmed: true },
    });
  });

  it('delays a new mempool transaction on an indexer that lags its node', async () => {
    const clock = new FakeClock();
    const node = new ScriptedEsploraNode({ clock });
    const base = node.endpoint('slow', { mempoolDelayMs: 2_000 });
    const [txid] = node.fund(OWN.address, 100_000n).split(':') as [string];
    const hex = signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[PAYEE, 90_000n]]);
    const sent = await node.fetch.fetch(`${base}/tx`, { method: 'POST', body: hex });
    expect(await sent.text()).toBe(idOf(hex));
    expect((await node.fetch.fetch(`${base}/tx/${idOf(hex)}`)).status).toBe(404);
    await clock.advance(2_000);
    expect((await node.fetch.fetch(`${base}/tx/${idOf(hex)}`)).status).toBe(200);
  });

  it('lets an intercept hang, answer asynchronously, or fail after the node accepted', async () => {
    const { node, base, post, spend } = setup();
    node.intercept('a', (_request, signal) => hang(signal));
    const controller = new AbortController();
    const pending = node.fetch.fetch(`${base}/blocks/tip/height`, {
      signal: controller.signal,
    });
    controller.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow('timed out');
    node.intercept('a', async () => ({ status: 429, text: 'Too Many Requests' }));
    expect((await node.fetch.fetch(`${base}/blocks/tip/height`)).status).toBe(429);
    const hex = spend(90_000n);
    node.intercept('a', (request, _signal, honest) => {
      if (request.method !== 'POST') return undefined;
      honest();
      return { status: 502, text: 'Bad Gateway' };
    });
    expect(await post(hex)).toEqual({ status: 502, text: 'Bad Gateway' });
    expect(node.inMempool(idOf(hex))).toBe(true);
    expect(node.broadcasts).toEqual([hex]);
    expect(node.sendCount(idOf(hex))).toBe(1);
    node.clearIntercept('a');
    expect(await post(hex)).toEqual({ status: 200, text: idOf(hex) });
    expect(() => node.intercept('zz', () => undefined)).toThrow();
    expect(() => node.setLag('zz', 1)).toThrow();
  });
});

describe('the modelled electrs: Blockstream new-index or mempool/electrs (M1)', () => {
  it('answers as mempool/electrs does with errorFormat "mempool"', async () => {
    const { node, post, get, txid } = setup({ errorFormat: 'mempool' });
    const parent = signedSpend(TEST_KEY, [[txid, 0, 100_000n]], [[OWN.script, 99_000n]]);
    await post(parent);
    const [stale] = node.mine() as [string];
    node.reorg(1, { drop: [idOf(parent)] });
    node.mine();
    // Its txstore serves a stale block's transactions; in light mode bitcoind has no index.
    expect(JSON.parse((await get(`/block/${stale}/txs`)).text)).toHaveLength(2);
    const light = node.endpoint('light', { lightMode: true });
    const lightTxs = await node.fetch.fetch(`${light}/block/${stale}/txs`);
    expect({ status: lightTxs.status, text: await lightTxs.text() }).toEqual({
      status: 400,
      text: 'missing tx',
    });
    // The range first (404), then the page boundary, with its own spelling.
    expect(await get(`/block/${stale}/txs/50`)).toEqual({
      status: 404,
      text: 'start index out of range',
    });
    expect(await get(`/block/${stale}/txs/1`)).toEqual({
      status: 400,
      text: 'start index must be a multipication of 25',
    });
    expect(await get('/tx/xyz')).toEqual({ status: 400, text: 'Invalid hex hash' });
    expect(await get('/address/nope')).toEqual({
      status: 400,
      text: 'Invalid Bitcoin address',
    });
    // A testnet-family backend takes any testnet-family address (tb1 on regtest).
    const tb = bitcoin.address.fromOutputScript(OWN.script, bitcoin.networks.testnet);
    expect(json(await get(`/address/${tb}`))).toMatchObject({
      address: tb,
      chain_stats: { funded_txo_sum: 100_000 },
    });
  });

  it.each(['blockstream', 'mempool'] as const)(
    "%s: orders one block's address history as its electrs does",
    async (errorFormat) => {
      const { node, post, spend, get } = setup({ errorFormat });
      const out = spend(90_000n);
      await post(out);
      const [late] = node.fund(OWN.address, 5_000n, { mempool: true }).split(':') as [
        string,
      ];
      node.mine();
      const page = JSON.parse((await get(`/address/${OWN.address}/txs/chain`)).text) as {
        txid: string;
      }[];
      // Blockstream: spending rows before funding rows; mempool/electrs: the block position,
      // last first.
      expect(page.slice(0, 2).map((t) => t.txid)).toEqual(
        errorFormat === 'blockstream' ? [idOf(out), late] : [late, idOf(out)],
      );
    },
  );
});

describe('paths the node does not model (M2)', () => {
  it('records one met through fetch, and fails the test that met it', async () => {
    const { node, post, spend } = setup();
    const truc = edited(spend(90_000n), (tx) => {
      tx.version = 3;
    });
    await expect(post(truc)).rejects.toThrow(/TRUC/);
    expect(node.unmodelled).toEqual([expect.stringMatching(/TRUC/)]);
    // The check every test file runs after each test (this one clears the node's list).
    expect(() => assertModelled()).toThrow(/unmodelled paths: .*TRUC/);
    expect(() => assertModelled()).not.toThrow();
  });
});

describe('Esplora routes', () => {
  it('serves blocks, their pages and timestamps as electrs does', async () => {
    const { node, get } = setup();
    for (let i = 0; i < 30; i++)
      node.fund(PAYEE_WALLET.address, 1_000n + BigInt(i), { mempool: true });
    const [hash] = node.mine() as [string];
    const genesis = json(await get(`/block/${node.options.genesisHash}`));
    const one = json(await get(`/block/${(await get('/block-height/1')).text}`));
    const block = json(await get(`/block/${hash}`));
    expect(genesis).toMatchObject({ height: 0, previousblockhash: null, tx_count: 1 });
    expect(block).toMatchObject({
      id: hash,
      height: 2,
      tx_count: 31,
      previousblockhash: one.id,
    });
    // A frozen clock: each block still moves past the median time of the last 11.
    expect(one.timestamp).toBe((genesis.timestamp as number) + 1);
    expect(block.timestamp).toBe((one.timestamp as number) + 1);
    expect(JSON.parse((await get(`/block/${hash}/txs`)).text)).toHaveLength(25);
    expect(JSON.parse((await get(`/block/${hash}/txs/25`)).text)).toHaveLength(6);
    // Blockstream's electrs checks the page boundary first, then the range, both 400.
    expect(await get(`/block/${hash}/txs/60`)).toEqual({
      status: 400,
      text: 'start index must be a multiple of 25',
    });
    expect(await get(`/block/${hash}/txs/50`)).toEqual({
      status: 400,
      text: 'start index out of range',
    });
    expect(JSON.parse((await get(`/block/${hash}/txids`)).text)).toEqual(
      node.blockTxids(2),
    );
    expect((await get(`/blocks/tip/hash`)).text).toBe(hash);
    const [coinbase] = node.blockTxids(2) as [string];
    expect(json(await get(`/tx/${coinbase}`))).toMatchObject({
      fee: 0,
      vin: [{ is_coinbase: true, prevout: null, txid: '0'.repeat(64) }],
    });
  });

  it('serves addresses: stats, unspent outputs and history pages', async () => {
    const { node, post, spend, get, txid } = setup();
    const [pending] = node.fund(OWN.address, 7_000n, { mempool: true }).split(':') as [
      string,
    ];
    const hex = spend(90_000n);
    await post(hex);
    expect(json(await get(`/address/${OWN.address}`))).toEqual({
      address: OWN.address,
      chain_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 100_000,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 1,
      },
      mempool_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 7_000,
        spent_txo_count: 1,
        spent_txo_sum: 100_000,
        tx_count: 2,
      },
    });
    expect(JSON.parse((await get(`/address/${OWN.address}/utxo`)).text)).toEqual([
      { txid: pending, vout: 0, status: { confirmed: false }, value: 7_000 },
    ]);
    node.mine();
    for (let i = 0; i < 25; i++) node.fund(OWN.address, 1_000n);
    const first = JSON.parse((await get(`/address/${OWN.address}/txs/chain`)).text) as {
      txid: string;
    }[];
    expect(first).toHaveLength(25);
    const rest = JSON.parse(
      (await get(`/address/${OWN.address}/txs/chain/${first[24]!.txid}`)).text,
    ) as { txid: string }[];
    expect(rest.map((t) => t.txid)).toEqual([idOf(hex), pending, txid]);
    expect(
      JSON.parse(
        (await get(`/address/${OWN.address}/txs/chain/${'ab'.repeat(32)}`)).text,
      ),
    ).toEqual([]);
    // Blockstream's electrs answers rust-bitcoin 0.32's parse error.
    expect(await get('/address/nope')).toEqual({ status: 400, text: 'base58 error' });
    expect(await get(`/address/${'1'.repeat(51)}`)).toEqual({
      status: 400,
      text: 'legacy address base58 string',
    });
    const program = new Uint8Array(20).fill(7);
    expect(await get(`/address/${bitcoin.address.toBech32(program, 0, 'tc')}`)).toEqual({
      status: 400,
      text: 'tried to parse an unknown hrp',
    });
    expect(await get(`/address/${bitcoin.address.toBase58Check(program, 0x30)}`)).toEqual(
      {
        status: 400,
        text: 'legacy address base58 prefix',
      },
    );
    const tb = bitcoin.address.fromOutputScript(OWN.script, bitcoin.networks.testnet);
    expect(await get(`/address/${tb}`)).toEqual({
      status: 400,
      text: 'Address on invalid network',
    });
    expect(await get('/address/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toEqual({
      status: 400,
      text: 'Address on invalid network',
    });
  });

  it('answers malformed paths and unknown routes as electrs does', async () => {
    const { node, get, txid } = setup();
    expect(await get('/tx/xyz')).toEqual({ status: 400, text: 'Invalid hex string' });
    expect(await get(`/tx/${txid}/outspend/x`)).toEqual({
      status: 400,
      text: 'Invalid number',
    });
    expect(await get('/block-height/x')).toEqual({ status: 400, text: 'Invalid number' });
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/blocks/tip/height/')).status).toBe(404);
    expect(JSON.parse((await get(`/tx/${'ab'.repeat(32)}/outspend/0`)).text)).toEqual({
      spent: false,
    });
    expect(JSON.parse((await get('/fee-estimates')).text)).toEqual({
      '2': 20,
      '6': 10,
      '144': 2,
    });
    node.setFeeEstimates({ '1': 3.5 });
    expect(JSON.parse((await get('/fee-estimates')).text)).toEqual({ '1': 3.5 });
  });
});
