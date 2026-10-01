import { ed25519 } from '@noble/curves/ed25519';
import {
  Address,
  beginCell,
  external,
  internal,
  storeMessage,
  storeMessageRelaxed,
  storeOutList,
  type Cell,
  type MessageRelaxed,
} from '@ton/core';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import {
  MONITOR,
  type V3Message,
  type V3Trace,
  type V3Transaction,
} from '../../../src/adapters/ton/api';
import {
  decodeTransaction,
  executed,
  jettonWalletToVerify,
} from '../../../src/adapters/ton/decode';
import {
  OP,
  commentCell,
  jettonMessage,
  nativeMessage,
  sdkAddress,
} from '../../../src/adapters/ton/messages';
import {
  REASONS,
  attemptVerdict,
  consumesSeqno,
  isOwnAttempt,
} from '../../../src/adapters/ton/trace';
import {
  normalizedHash,
  resolveIdentity,
  walletIdOf,
} from '../../../src/adapters/ton/wallets';
import { signedBoc, testWallet, tonNode } from './support/harness';
import { NODE_FEES } from './support/node';
import { KEY, PUBLIC_KEY } from './support/vectors';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const FRESH = `0:${'11'.repeat(32)}`;
const MASTER = `0:${'77'.repeat(32)}`;

/** Decides nothing: a retryable contradiction of the chain or the signed request. */
const inconsistent = expect.objectContaining({
  code: 'PROVIDER_INCONSISTENT',
  retryable: true,
});

async function send(
  t: ReturnType<typeof tonNode>,
  messages: (wallet: string) => MessageRelaxed[],
  funds = 3n * GRAM,
) {
  const wallet = testWallet('v4r2', TESTNET);
  t.node.fund(wallet, funds);
  const { boc, hashNorm } = await signedBoc('v4r2', TESTNET, {
    seqno: 0,
    validUntil: Math.floor(t.clock.now() / 1000) + 60,
    deploy: true,
    messages: messages(wallet),
  });
  t.node.submit(boc);
  return { wallet, hashNorm };
}

async function verdictAfter(t: ReturnType<typeof tonNode>, hashNorm: string) {
  const [root] = await t.run(t.api.transactionsByMessage(hashNorm, MONITOR));
  if (!root) throw new Error('not indexed');
  const trace = await t.run(t.api.trace(root.hash, MONITOR));
  return { root, trace, verdict: attemptVerdict(root, trace) };
}

// An Attempt succeeded only when value moved: the wallet's compute and action phases
// succeeded, every requested message went out, no native message bounced, and every
// jetton hop moved a positive amount from the sender between the master's own jetton
// wallets of the sender and the intended recipient. Anything else the chain records as a
// failure is `failed` with a fixed reason.
describe('the attempt verdict', () => {
  it('waits for the trace, then proves a native transfer that landed', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false, memo: 'invoice 7' }),
    ]);
    t.node.mine();
    expect((await verdictAfter(t, hashNorm)).verdict).toEqual({ kind: 'pending' });
    t.node.mine();
    expect((await verdictAfter(t, hashNorm)).verdict).toEqual({
      kind: 'success',
      legs: [],
    });
  });

  // Send mode +2 is mandatory, so a message the balance no longer covers is skipped: the
  // wallet transaction succeeds and consumes the seqno, yet nothing moved.
  it('fails a request whose message the wallet skipped', async () => {
    const t = tonNode();
    const { hashNorm } = await send(
      t,
      () => [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
      GRAM / 10n,
    );
    t.node.mine();
    const { root, verdict } = await verdictAfter(t, hashNorm);
    expect(root).toMatchObject({ aborted: false, compute: { success: true } });
    expect(verdict).toEqual({ kind: 'failed', reason: REASONS.skipped });
  });

  it('decides nothing when a message is missing that the wallet did not skip', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    const dropped = { ...root, outMsgs: [] };
    expect(() => attemptVerdict(dropped, trace)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INCONSISTENT', retryable: true }),
    );
    // Only the wallet's own record of a skipped action proves the skip (a skipped message
    // is one the action phase did not create).
    const skipped = {
      ...dropped,
      action: { ...root.action!, skippedActions: 1, msgsCreated: 0 },
    };
    expect(attemptVerdict(skipped, trace)).toEqual({
      kind: 'failed',
      reason: REASONS.skipped,
    });
  });

  // A bounceable transfer to an uninitialized recipient comes back, minus fees.
  it('fails a bounced native transfer', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
    ]);
    t.node.mine(3);
    const { root, trace, verdict } = await verdictAfter(t, hashNorm);
    expect(verdict).toEqual({ kind: 'failed', reason: REASONS.bounced });
    // A bounceable message whose compute phase failed always gets a bounce phase
    // (collator.cpp): a record without one lacks data, and is never a delivery.
    const unbounced = replaced(trace!, FRESH, ({ bounce: _bounce, ...tx }) => tx);
    expect(() => attemptVerdict(root, unbounced)).toThrow(inconsistent);
    // The flag we signed decides, even when the indexer leaves the delivery's out.
    const unflagged = replaced(trace!, FRESH, ({ bounce: _bounce, ...tx }) => ({
      ...tx,
      inMsg: { ...tx.inMsg!, bounce: null },
    }));
    expect(() => attemptVerdict(withoutFlags(root), unflagged)).toThrow(inconsistent);
  });

  it('fails a batch when one of its outputs bounced', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: `0:${'12'.repeat(32)}`, value: GRAM, bounce: false }),
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
    ]);
    t.node.mine(3);
    expect((await verdictAfter(t, hashNorm)).verdict).toEqual({
      kind: 'failed',
      reason: REASONS.bounced,
    });
  });

  describe('jettons', () => {
    const jettonSend = async (t: ReturnType<typeof tonNode>, amount: bigint) => {
      t.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
      return send(t, (wallet) => {
        t.node.mintJetton(MASTER, wallet, 1_000_000n);
        return [
          jettonMessage({
            jettonWallet: t.node.jettonWalletOf(MASTER, wallet),
            attached: 50_000_000n,
            queryId: 0n,
            amount,
            destination: FRESH,
            responseDestination: wallet,
            forwardAmount: 1n,
          }),
        ];
      });
    };

    it('proves a jetton transfer only once the recipient jetton wallet took it', async () => {
      const t = tonNode();
      const { hashNorm } = await jettonSend(t, 400_000n);
      t.node.mine(2);
      expect((await verdictAfter(t, hashNorm)).verdict).toEqual({ kind: 'pending' });
      t.node.mine(3);
      const wallet = testWallet('v4r2', TESTNET);
      expect((await verdictAfter(t, hashNorm)).verdict).toEqual({
        kind: 'success',
        legs: [
          {
            senderWallet: t.node.jettonWalletOf(MASTER, wallet),
            recipientWallet: t.node.jettonWalletOf(MASTER, FRESH),
            recipient: FRESH,
          },
        ],
      });
    });

    it('decides nothing when the jetton wallet ran the transfer but sent nothing', async () => {
      const t = tonNode();
      const { hashNorm } = await jettonSend(t, 400_000n);
      t.node.mine(5);
      const { root, trace } = await verdictAfter(t, hashNorm);
      const complete = trace as V3Trace;
      const hop = complete.transactions.find(
        (tx) => tx.inMsg?.hash === root.outMsgs[0]?.hash,
      );
      const silent: V3Trace = {
        ...complete,
        transactions: complete.transactions.map((tx) =>
          tx === hop ? { ...tx, outMsgs: [] } : tx,
        ),
      };
      expect(hop).toBeDefined();
      expect(() => attemptVerdict(root, silent)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_INCONSISTENT', retryable: true }),
      );
    });

    it('fails a jetton transfer the sender jetton wallet bounced', async () => {
      const t = tonNode();
      const { hashNorm } = await jettonSend(t, 5_000_000n);
      t.node.mine(5);
      expect((await verdictAfter(t, hashNorm)).verdict).toEqual({
        kind: 'failed',
        reason: REASONS.jettonBounced,
      });
    });

    it("fails a jetton transfer the recipient's jetton wallet refused", async () => {
      const t = tonNode();
      t.node.failJettonWallet(t.node.jettonWalletOf(MASTER, FRESH));
      const { hashNorm } = await jettonSend(t, 400_000n);
      t.node.mine(6);
      expect((await verdictAfter(t, hashNorm)).verdict).toEqual({
        kind: 'failed',
        reason: REASONS.jettonBounced,
      });
    });

    it('fails a jetton transfer that moved nothing (the phantom-success rule)', async () => {
      const t = tonNode();
      const { hashNorm } = await jettonSend(t, 0n);
      t.node.mine(5);
      const { trace, verdict } = await verdictAfter(t, hashNorm);
      expect(trace?.complete).toBe(true);
      expect(verdict).toEqual({ kind: 'failed', reason: REASONS.jettonBounced });
      // A verified wallet's zero credit moved nothing, so no transfer is decoded.
      const recipientWallet = t.node.jettonWalletOf(MASTER, FRESH);
      const verified = { address: recipientWallet, owner: FRESH, master: MASTER };
      const arrival = trace!.transactions.find((tx) => tx.account === recipientWallet)!;
      const notification = trace!.transactions.find((tx) => tx.account === FRESH)!;
      for (const tx of [arrival, notification]) {
        const decoded = decodeTransaction(tx, { jetton: verified });
        expect(decoded.transfers.some((x) => x.source === 'token-event')).toBe(false);
      }
      expect(decodeTransaction(notification, { jetton: verified }).decoding).toBe(
        'complete',
      );
    });

    it('fails a jetton transfer whose credit the recipient wallet rolled back', async () => {
      const t = tonNode();
      const { hashNorm } = await jettonSend(t, 400_000n);
      t.node.mine(5);
      const { root, trace } = await verdictAfter(t, hashNorm);
      const recipientWallet = t.node.jettonWalletOf(MASTER, FRESH);
      // A failed action phase drops the compute phase's state: no credit, and without +16
      // no bounce either (transaction.cpp).
      const rolledBack = replaced(trace!, recipientWallet, (tx) => ({
        ...tx,
        aborted: true,
        action: { ...tx.action!, success: false, resultCode: 37, msgsCreated: 0 },
        outMsgs: [],
      }));
      expect(attemptVerdict(root, rolledBack)).toEqual({
        kind: 'failed',
        reason: REASONS.jettonBounced,
      });
    });

    it('decides nothing for an internal_transfer the chain could not have sent (707)', async () => {
      const t = tonNode();
      const { wallet, hashNorm } = await jettonSend(t, 400_000n);
      t.node.mine(5);
      const { root, trace } = await verdictAfter(t, hashNorm);
      const senderWallet = t.node.jettonWalletOf(MASTER, wallet);
      const recipientWallet = t.node.jettonWalletOf(MASTER, FRESH);
      const hop = trace!.transactions.find((tx) => tx.account === senderWallet)!;
      const onward = hop.outMsgs[0]!;
      // The hop names another owner as `from`: not the transfer we signed.
      const named = withBody(onward, internalTransfer(400_000n, FRESH));
      const otherOwner = replaced(trace!, senderWallet, (tx) => ({
        ...tx,
        outMsgs: [named],
      }));
      expect(() => attemptVerdict(root, otherOwner)).toThrow(inconsistent);
      // The receiving wallet took it from someone other than our jetton wallet.
      const elsewhere = replaced(trace!, recipientWallet, (tx) => ({
        ...tx,
        inMsg: { ...tx.inMsg!, source: MASTER },
      }));
      expect(() => attemptVerdict(root, elsewhere)).toThrow(inconsistent);
      // The hop's own record names another sender for the message it sent.
      const disowned = replaced(trace!, senderWallet, (tx) => ({
        ...tx,
        outMsgs: tx.outMsgs.map((m) => (m === onward ? { ...m, source: MASTER } : m)),
      }));
      expect(() => attemptVerdict(root, disowned)).toThrow(inconsistent);
      // The arrival's copy of the message carries another bounce flag than the hop's.
      const reflagged = replaced(trace!, recipientWallet, (tx) => ({
        ...tx,
        inMsg: { ...tx.inMsg!, bounce: !tx.inMsg!.bounce },
      }));
      expect(() => attemptVerdict(root, reflagged)).toThrow(inconsistent);
      // A jetton wallet whose record lacks its action phase proves no failure.
      const { action: _action, ...unrecorded } = hop;
      const silent = replaced(trace!, senderWallet, () => ({
        ...unrecorded,
        aborted: true,
      }));
      expect(() => attemptVerdict(root, silent)).toThrow(inconsistent);
    });
  });

  it('treats a complete trace that lacks a delivered message as inconsistent (retryable)', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    const hollow: V3Trace = { ...(trace as V3Trace), transactions: [root] };
    expect(() => attemptVerdict(root, hollow)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INCONSISTENT', retryable: true }),
    );
  });
});

// A run that did not consume its seqno can run again until the message expires, so a
// `failed` verdict there could be followed by the message paying after all.
describe('only a request that consumed its seqno is decided', () => {
  it('never fails a request whose action phase failed: the same message runs again', async () => {
    const t = tonNode();
    const wallet = testWallet('v4r2', TESTNET);
    // Send mode 1, without +2: a message the balance cannot pay fails the whole action
    // phase (37), which drops the committed seqno with it (transaction.cpp).
    const { boc, hashNorm } = v4Request(t, [
      [1, nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    ]);
    t.node.fund(wallet, GRAM / 10n);
    t.node.submit(boc);
    t.node.mine(2);
    const { root: first, trace, verdict } = await verdictAfter(t, hashNorm);
    expect(first).toMatchObject({
      aborted: true,
      compute: { success: true },
      action: { success: false, resultCode: 37 },
    });
    expect(trace?.complete).toBe(true);
    expect(consumesSeqno(first)).toBe(false);
    expect(verdict).toEqual({ kind: 'pending' });
    // Anyone may replay it until it expires; once the wallet can pay, the value moves.
    t.node.fund(wallet, 3n * GRAM);
    t.node.submit(boc);
    t.node.mine(2);
    const runs = await t.run(t.api.transactionsByMessage(hashNorm, MONITOR));
    const second = runs.find((tx) => tx.hash !== first.hash)!;
    expect(runs).toHaveLength(2);
    expect(consumesSeqno(second)).toBe(true);
    expect(
      attemptVerdict(second, await t.run(t.api.trace(second.hash, MONITOR))),
    ).toEqual({ kind: 'success', legs: [] });
    expect(t.node.balance(FRESH)).toBe(GRAM);
    expect(attemptVerdict(first, trace)).toEqual({ kind: 'pending' });
  });

  it('never fails a request that ran out of gas before it committed its seqno (-14)', async () => {
    const t = tonNode();
    // The balance pays the import fee and the accept, not the whole run.
    const { hashNorm } = await send(
      t,
      () => [nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
      2_000_000n,
    );
    t.node.mine();
    const { root, verdict } = await verdictAfter(t, hashNorm);
    expect(root).toMatchObject({
      aborted: true,
      compute: { success: false, exitCode: -14 },
    });
    expect(consumesSeqno(root)).toBe(false);
    expect(verdict).toEqual({ kind: 'pending' });
    expect(executed(root)).toBe(false);
    expect(decodeTransaction(root)).toMatchObject({
      observation: { success: false },
      transfers: [],
    });
  });

  it('fails a W5 request refused after it committed its seqno (137), decided from the wallet transaction alone', async () => {
    const t = tonNode();
    const wallet = testWallet('v5r1', TESTNET);
    t.node.fund(wallet, 3n * GRAM);
    // Send mode 1, without +2: W5 commits the next seqno with an empty action list, then
    // throws 137 (wallet_v5.fc).
    const { boc, hashNorm } = w5Request(t, [
      [1, nativeMessage({ to: FRESH, value: GRAM, bounce: false })],
    ]);
    t.node.submit(boc);
    t.node.mine();
    const { root } = await verdictAfter(t, hashNorm);
    // transaction.cpp: `success = accepted && committed`, so the compute phase succeeded
    // with 137 and the committed, empty action list ran; nothing is aborted.
    expect(root).toMatchObject({
      aborted: false,
      compute: { success: true, exitCode: 137 },
      action: { success: true, msgsCreated: 0 },
      outMsgs: [],
    });
    expect(t.node.seqno(wallet)).toBe(1);
    expect(consumesSeqno(root)).toBe(true);
    expect(attemptVerdict(root, null)).toEqual({
      kind: 'failed',
      reason: REASONS.walletFailed,
    });
    expect(executed(root)).toBe(false);
    // W5 commits an empty action list before it throws: a message it created would
    // contradict the chain's own record.
    const created: V3Message = {
      hash: 'aa'.repeat(32),
      source: wallet,
      destination: FRESH,
      value: GRAM,
      bounce: false,
      bounced: false,
      bodyHash: beginCell().endCell().hash().toString('hex'),
    };
    const threwAndSent = {
      ...root,
      action: { ...root.action!, msgsCreated: 1 },
      outMsgs: [created],
    };
    expect(() => attemptVerdict(threwAndSent, null)).toThrow(inconsistent);
    // An indexer that wrote the refusal as a failed compute phase: W5's alone, since
    // no other wallet commits its seqno and then throws 137.
    const { action: _action, ...computeOnly } = root;
    const failedCompute: V3Transaction = {
      ...computeOnly,
      aborted: true,
      compute: { skipped: false, success: false, exitCode: 137 },
    };
    expect(consumesSeqno(failedCompute)).toBe(true);
    expect(attemptVerdict(failedCompute, null)).toEqual({
      kind: 'failed',
      reason: REASONS.walletFailed,
    });
    // Any other failed compute phase left the old seqno: it decides nothing.
    const uncommitted = {
      ...failedCompute,
      compute: { ...failedCompute.compute, exitCode: 9 },
    };
    expect(consumesSeqno(uncommitted)).toBe(false);
    expect(attemptVerdict(uncommitted, null)).toEqual({ kind: 'pending' });
    // A v4r2 request never throws 137: the same record consumed nothing there.
    const v4 = tonNode();
    const sent = await send(v4, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    v4.node.mine();
    const { root: v4root } = await verdictAfter(v4, sent.hashNorm);
    const { action: _v4action, ...v4compute } = v4root;
    const v4failed: V3Transaction = {
      ...v4compute,
      aborted: true,
      compute: { skipped: false, success: false, exitCode: 137 },
      outMsgs: [],
    };
    expect(consumesSeqno(v4failed)).toBe(false);
    expect(attemptVerdict(v4failed, null)).toEqual({ kind: 'pending' });
  });
});

describe('what moved to a native recipient', () => {
  it('counts a dust bounce (nofunds) as delivered: the value stays', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: 100_000n, bounce: true }),
    ]);
    t.node.mine(2);
    const { trace, verdict } = await verdictAfter(t, hashNorm);
    const hop = trace?.transactions.find((tx) => tx.account === FRESH);
    expect(hop).toMatchObject({ aborted: true, bounce: 'nofunds' });
    expect(verdict).toEqual({ kind: 'success', legs: [] });
    expect(t.node.balance(FRESH)).toBe(100_000n);
    expect(executed(hop!)).toBe(true);
    expect(decodeTransaction(hop!).transfers).toEqual([
      expect.objectContaining({ locator: 'msg:in', to: FRESH, amount: 100_000n }),
    ]);
  });

  it('counts a non-bounceable message a failing contract kept as delivered', async () => {
    const t = tonNode();
    const reverter = `0:${'33'.repeat(32)}`;
    t.node.deployReverter(reverter);
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: reverter, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace, verdict } = await verdictAfter(t, hashNorm);
    expect(trace?.transactions.find((tx) => tx.account === reverter)).toMatchObject({
      aborted: true,
      compute: { success: false },
    });
    expect(verdict).toEqual({ kind: 'success', legs: [] });
    // Only a bounceable message has a bounce phase (transaction.cpp `bounce_enabled`):
    // a bounce on this one is a record the chain never writes, never a refund.
    const bouncedBack = replaced(trace!, reverter, (tx) => ({ ...tx, bounce: 'ok' }));
    expect(() => attemptVerdict(root, bouncedBack)).toThrow(inconsistent);
    // The flag we signed decides, even when the indexer leaves the delivery's out.
    const unflagged = replaced(trace!, reverter, (tx) => ({
      ...tx,
      bounce: 'ok',
      inMsg: { ...tx.inMsg!, bounce: null },
    }));
    expect(() => attemptVerdict(withoutFlags(root), unflagged)).toThrow(inconsistent);
  });

  it('counts a failed action phase at the recipient as delivered, unless it bounced (+16)', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
    ]);
    t.node.mine(3);
    const { root, trace } = await verdictAfter(t, hashNorm);
    const actionFailed = (tx: V3Transaction): V3Transaction => ({
      ...tx,
      aborted: true,
      compute: { skipped: false, success: true, exitCode: 0 },
      action: { success: false, resultCode: 37, skippedActions: 0, msgsCreated: 0 },
      outMsgs: [],
    });
    const { bounce: _bounce, ...unbounced } = actionFailed(
      trace!.transactions.find((tx) => tx.account === FRESH)!,
    );
    expect(
      attemptVerdict(
        root,
        replaced(trace!, FRESH, () => unbounced),
      ),
    ).toEqual({
      kind: 'success',
      legs: [],
    });
    expect(
      attemptVerdict(
        root,
        replaced(trace!, FRESH, (tx) => ({ ...actionFailed(tx), bounce: 'ok' })),
      ),
    ).toEqual({ kind: 'failed', reason: REASONS.bounced });
  });
});

describe('an answer that contradicts the chain or the request decides nothing', () => {
  it('refuses a wallet transaction whose record contradicts itself or the request', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    expect(attemptVerdict(root, trace)).toEqual({ kind: 'success', legs: [] });
    const { action: _action, ...noAction } = root;
    const out = root.outMsgs[0]!;
    const contradictions: V3Transaction[] = [
      // An action phase follows exactly a compute phase that succeeded.
      noAction,
      { ...noAction, aborted: true },
      {
        ...root,
        aborted: true,
        compute: { skipped: false, success: false, exitCode: 0 },
      },
      // `aborted` is exactly "a phase failed".
      { ...root, aborted: true },
      { ...root, compute: { skipped: false, success: false, exitCode: 0 } },
      // A message the request did not ask for.
      { ...root, outMsgs: [out, { ...out, hash: 'cd'.repeat(32) }] },
      // A skipped action, yet every message went out.
      { ...root, action: { ...root.action!, skippedActions: 1 } },
      // Not an external request.
      { ...root, inMsg: { ...root.inMsg!, source: FRESH } },
      // The message went out with another bounce flag than the one signed.
      { ...root, outMsgs: [{ ...out, bounce: true }] },
    ];
    for (const tx of contradictions) {
      expect(() => attemptVerdict(tx, trace)).toThrow(inconsistent);
    }
    expect(() => executed({ ...root, aborted: true })).toThrow(inconsistent);
    expect(() => consumesSeqno(noAction)).toThrow(inconsistent);
    // A skipped compute phase never succeeded, and always aborts (transaction.cpp).
    const deposit = trace!.transactions.find((tx) => tx.account === FRESH)!;
    expect(deposit).toMatchObject({ aborted: true, compute: { skipped: true } });
    // In decoding: a bounce on a non-bounceable deposit would drop a credit; a failed
    // bounceable one without a bounce would credit value that went back.
    expect(() => executed({ ...deposit, bounce: 'ok' })).toThrow(inconsistent);
    expect(() =>
      executed({ ...deposit, inMsg: { ...deposit.inMsg!, bounce: true } }),
    ).toThrow(inconsistent);
    expect(() => executed({ ...deposit, aborted: false })).toThrow(inconsistent);
    expect(() =>
      executed({
        ...deposit,
        aborted: false,
        compute: { skipped: true, success: true },
        action: { success: true, resultCode: 0, skippedActions: 0, msgsCreated: 0 },
      }),
    ).toThrow(inconsistent);
  });

  it('reads a bounce message whose flag the indexer leaves out as the bounce it is', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
    ]);
    t.node.mine(2);
    const { trace } = await verdictAfter(t, hashNorm);
    // A bounceable transfer to an address with no code bounces: its only message goes back.
    const bounced = trace!.transactions.find((tx) => tx.account === FRESH)!;
    expect(bounced).toMatchObject({ aborted: true, bounce: 'ok' });
    expect(bounced.outMsgs).toHaveLength(1);
    const back = bounced.outMsgs[0]!;
    expect(executed(bounced)).toBe(false);
    // An indexer that omits the flag says nothing against the chain; one that says the
    // message is not a bounce contradicts it.
    expect(executed({ ...bounced, outMsgs: [{ ...back, bounced: null }] })).toBe(false);
    expect(() =>
      executed({ ...bounced, outMsgs: [{ ...back, bounced: false }] }),
    ).toThrow(inconsistent);
  });

  it("cross-checks the chain's own counters", async () => {
    const t = tonNode();
    const request = nativeMessage({ to: FRESH, value: GRAM, bounce: false });
    const { hashNorm } = await send(t, () => [request, request]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    expect(attemptVerdict(root, trace)).toEqual({ kind: 'success', legs: [] });
    const [first] = root.outMsgs;
    const counters: V3Transaction[] = [
      // One message listed twice.
      { ...root, outMsgs: [first!, first!] },
      // Another count of created messages than listed.
      { ...root, action: { ...root.action!, msgsCreated: 3 } },
      // Another count of skipped messages than missing.
      {
        ...root,
        outMsgs: [],
        action: { ...root.action!, skippedActions: 3, msgsCreated: 0 },
      },
    ];
    for (const tx of counters) {
      expect(() => attemptVerdict(tx, trace)).toThrow(inconsistent);
    }
  });

  it('checks every output before it decides', async () => {
    const t = tonNode();
    const other = `0:${'12'.repeat(32)}`;
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
      nativeMessage({ to: other, value: GRAM, bounce: false }),
    ]);
    t.node.mine(3);
    const { root, trace, verdict } = await verdictAfter(t, hashNorm);
    expect(verdict).toEqual({ kind: 'failed', reason: REASONS.bounced });
    // The first output bounced; the second one's delivery contradicts the message sent.
    const elsewhere = replaced(trace!, other, (tx) => ({
      ...tx,
      account: `0:${'13'.repeat(32)}`,
    }));
    expect(() => attemptVerdict(root, elsewhere)).toThrow(inconsistent);
  });

  it('refuses a trace whose delivery is not the message the wallet sent', async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    const hop = trace!.transactions.find((tx) => tx.account === FRESH)!;
    const traces: V3Trace[] = [
      replaced(trace!, FRESH, (tx) => ({ ...tx, account: `0:${'12'.repeat(32)}` })),
      replaced(trace!, FRESH, (tx) => ({
        ...tx,
        inMsg: { ...tx.inMsg!, value: GRAM / 2n },
      })),
      {
        ...trace!,
        transactions: [...trace!.transactions, { ...hop, hash: 'ef'.repeat(32) }],
      },
      // A transaction that did not run sends nothing but its bounce.
      replaced(trace!, FRESH, (tx) => ({
        ...tx,
        outMsgs: [{ ...root.outMsgs[0]!, hash: 'dd'.repeat(32), source: FRESH }],
      })),
      // A bounce phase follows only a failed phase.
      replaced(trace!, FRESH, (tx) => ({
        ...tx,
        aborted: false,
        compute: { skipped: false, success: true, exitCode: 0 },
        action: { success: true, resultCode: 0, skippedActions: 0, msgsCreated: 0 },
        bounce: 'ok',
      })),
    ];
    for (const next of traces) {
      expect(() => attemptVerdict(root, next)).toThrow(inconsistent);
    }
    // The delivery carries another bounce flag than the message the wallet signed,
    // decided by the signed flag although the indexer left the sent copy's out.
    const reflagged = replaced(trace!, FRESH, (tx) => ({
      ...tx,
      aborted: false,
      compute: { skipped: false, success: true, exitCode: 0 },
      action: { success: true, resultCode: 0, skippedActions: 0, msgsCreated: 0 },
      inMsg: { ...tx.inMsg!, bounce: true },
    }));
    expect(() => attemptVerdict(withoutFlags(root), reflagged)).toThrow(inconsistent);
    // The message went out with another flag than signed, the delivery's left out.
    const sentOtherwise = { ...root, outMsgs: [{ ...root.outMsgs[0]!, bounce: true }] };
    const unflagged = replaced(trace!, FRESH, (tx) => ({
      ...tx,
      inMsg: { ...tx.inMsg!, bounce: null },
    }));
    expect(() => attemptVerdict(sentOtherwise, unflagged)).toThrow(inconsistent);
  });

  it('refuses to judge a request message that is neither a plain transfer nor a jetton transfer', async () => {
    const withBodyOf = (body: Cell) =>
      internal({ to: sdkAddress(FRESH), value: GRAM, bounce: false, body });
    for (const message of [
      withBodyOf(beginCell().storeUint(0xdeadbeef, 32).endCell()),
      // A jetton transfer to a workchain that names no TON account.
      withBodyOf(
        beginCell()
          .storeUint(OP.jettonTransfer, 32)
          .storeUint(0, 64)
          .storeCoins(1n)
          .storeAddress(new Address(5, Buffer.alloc(32, 0x11)))
          .storeAddress(null)
          .storeMaybeRef(null)
          .storeCoins(0n)
          .storeBit(false)
          .endCell(),
      ),
      // It moves nothing: our builder never signs one (the core refuses a zero amount).
      nativeMessage({ to: FRESH, value: 0n, bounce: false }),
    ]) {
      const t = tonNode();
      const { hashNorm } = await send(t, () => [message]);
      t.node.mine(2);
      const [root] = await t.run(t.api.transactionsByMessage(hashNorm, MONITOR));
      const trace = await t.run(t.api.trace(root!.hash, MONITOR));
      expect(trace?.complete).toBe(true);
      expect(() => attemptVerdict(root!, trace)).toThrow(inconsistent);
    }
  });
});

describe('our own Attempt', () => {
  it('is the external message to our wallet whose TEP-467 hash, computed here, is the id', async () => {
    const t = tonNode();
    const { wallet, hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    expect(isOwnAttempt(root, wallet, hashNorm)).toBe(true);
    expect(isOwnAttempt(root, FRESH, hashNorm)).toBe(false);
    expect(isOwnAttempt(root, wallet, 'ab'.repeat(32))).toBe(false);
    const deposit = trace!.transactions.find((tx) => tx.account === FRESH)!;
    expect(isOwnAttempt(deposit, FRESH, hashNorm)).toBe(false);
    // The indexer's `hash_norm` only finds candidates: another body never matches.
    const otherBody = { ...root, inMsg: withBody(root.inMsg!, commentCell('other')) };
    expect(otherBody.inMsg.hashNorm).toBe(hashNorm);
    expect(isOwnAttempt(otherBody, wallet, hashNorm)).toBe(false);
    // A body that does not hash to its keyed hash is a malformed answer.
    const unbound = {
      ...root,
      inMsg: { ...root.inMsg!, bodyHash: commentCell('other').hash().toString('hex') },
    };
    expect(() => isOwnAttempt(unbound, wallet, hashNorm)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
  });
});

// Decoding reports what the chain did, for anyone's transactions: the verdict's checks
// run on the verdict paths only.
describe('transaction decoding', () => {
  it('decodes a wallet payment and the credited deposit on a fresh address', async () => {
    const t = tonNode();
    const { wallet, hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false, memo: 'invoice 7' }),
    ]);
    t.node.mine(2);
    const { root, trace } = await verdictAfter(t, hashNorm);
    expect(decodeTransaction(root, { blockHash: 'ab'.repeat(32) })).toMatchObject({
      id: root.hash,
      observation: { seen: 'block', txHash: root.hash, blockHeight: 2n, success: true },
      decoding: 'complete',
      transfers: [
        {
          locator: 'msg:0',
          from: [wallet],
          to: FRESH,
          asset: 'native',
          amount: GRAM,
          memo: 'invoice 7',
        },
      ],
      details: { messageHash: hashNorm },
    });
    const deposit = trace?.transactions.find((tx) => tx.account === FRESH);
    expect(deposit).toMatchObject({ aborted: true, compute: { skipped: true } });
    expect(executed(deposit!)).toBe(true);
    expect(decodeTransaction(deposit!).transfers).toEqual([
      expect.objectContaining({
        locator: 'msg:in',
        to: FRESH,
        amount: GRAM,
        memo: 'invoice 7',
      }),
    ]);
  });

  it('reports a bounced deposit as not executed: no credit, only the bounce back', async () => {
    const t = tonNode();
    const { wallet, hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: true }),
    ]);
    t.node.mine(3);
    const { trace } = await verdictAfter(t, hashNorm);
    const bounced = trace?.transactions.find((tx) => tx.account === FRESH);
    expect(executed(bounced!)).toBe(false);
    expect(decodeTransaction(bounced!)).toMatchObject({
      observation: { success: false },
      transfers: [
        {
          locator: 'msg:0',
          from: [FRESH],
          to: wallet,
          asset: 'native',
          amount: GRAM - NODE_FEES.internalGas,
          source: 'internal',
        },
      ],
    });
    // The refund arriving back is the sender's own value, not a payment to it.
    const refund = trace?.transactions.find(
      (tx) => tx.account === wallet && tx.inMsg?.bounced === true,
    );
    expect(decodeTransaction(refund!).transfers).toEqual([
      expect.objectContaining({
        locator: 'msg:in',
        to: wallet,
        amount: GRAM - NODE_FEES.internalGas,
        source: 'internal',
      }),
    ]);
  });

  it('decodes jettons only for a jetton wallet the reader verified', async () => {
    const t = tonNode();
    t.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const { wallet, hashNorm } = await send(t, (w) => {
      t.node.mintJetton(MASTER, w, 1_000_000n);
      return [
        jettonMessage({
          jettonWallet: t.node.jettonWalletOf(MASTER, w),
          attached: 50_000_000n,
          queryId: 0n,
          amount: 400_000n,
          destination: FRESH,
          responseDestination: w,
          forwardAmount: 1n,
          memo: 'order 9',
        }),
      ];
    });
    t.node.mine(5);
    const { root, trace } = await verdictAfter(t, hashNorm);
    expect(decodeTransaction(root).decoding).toBe('partial');
    const recipientWallet = t.node.jettonWalletOf(MASTER, FRESH);
    const arrival = trace!.transactions.find((tx) => tx.account === recipientWallet)!;
    const notification = trace!.transactions.find((tx) => tx.account === FRESH)!;
    expect(jettonWalletToVerify(arrival)).toBe(recipientWallet);
    expect(jettonWalletToVerify(notification)).toBe(recipientWallet);
    const verified = { address: recipientWallet, owner: FRESH, master: MASTER };
    const token = {
      locator: 'msg:in:jetton',
      from: [wallet],
      to: FRESH,
      asset: { standard: 'jetton', contract: MASTER },
      amount: 400_000n,
      source: 'token-event',
      memo: 'order 9',
    };
    expect(decodeTransaction(arrival, { jetton: verified }).transfers).toContainEqual(
      token,
    );
    expect(
      decodeTransaction(notification, { jetton: verified }).transfers,
    ).toContainEqual(token);
    const unverified = decodeTransaction(notification);
    expect(unverified.decoding).toBe('partial');
    expect(unverified.transfers.some((x) => x.source === 'token-event')).toBe(false);
    const impostor = { ...verified, owner: wallet };
    expect(
      decodeTransaction(notification, { jetton: impostor }).transfers.some(
        (x) => x.source === 'token-event',
      ),
    ).toBe(false);
    // A failed phase drops the credit, bounced or not: no jetton moved, and nothing is
    // left to verify, although the TON the message carried stayed.
    const rolledBack: V3Transaction = {
      ...arrival,
      aborted: true,
      action: { ...arrival.action!, success: false, resultCode: 37, msgsCreated: 0 },
      outMsgs: [],
    };
    expect(executed(rolledBack)).toBe(true);
    expect(jettonWalletToVerify(rolledBack)).toBeUndefined();
    const undone = decodeTransaction(rolledBack, { jetton: verified });
    expect(undone.decoding).toBe('complete');
    expect(undone.transfers).toEqual([
      expect.objectContaining({ locator: 'msg:in', asset: 'native' }),
    ]);
  });

  it("names a wallet request by the hash computed from its bound body, not the indexer's", async () => {
    const t = tonNode();
    const { hashNorm } = await send(t, () => [
      nativeMessage({ to: FRESH, value: GRAM, bounce: false }),
    ]);
    t.node.mine(2);
    const { root } = await verdictAfter(t, hashNorm);
    const claimed = { ...root, inMsg: { ...root.inMsg!, hashNorm: 'ab'.repeat(32) } };
    expect(decodeTransaction(claimed).details).toMatchObject({ messageHash: hashNorm });
  });
});

/** `root` as an indexer that leaves its outgoing messages' bounce flags out writes it. */
function withoutFlags(root: V3Transaction): V3Transaction {
  return { ...root, outMsgs: root.outMsgs.map((m) => ({ ...m, bounce: null })) };
}

/** `trace` with the transaction of `account` replaced by `change(tx)`. */
function replaced(
  trace: V3Trace,
  account: string,
  change: (tx: V3Transaction) => V3Transaction,
): V3Trace {
  return {
    ...trace,
    transactions: trace.transactions.map((tx) =>
      tx.account === account ? change(tx) : tx,
    ),
  };
}

/** `message` carrying `body`, bound to its hash as the indexer serves it. */
function withBody(message: V3Message, body: Cell): V3Message {
  return {
    ...message,
    body: body.toBoc().toString('base64'),
    bodyHash: body.hash().toString('hex'),
  };
}

/** A TEP-74 `internal_transfer` of `amount`, naming `from` as the sending owner. */
function internalTransfer(amount: bigint, from: string): Cell {
  return beginCell()
    .storeUint(OP.jettonInternalTransfer, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(sdkAddress(from))
    .storeAddress(null)
    .storeCoins(0)
    .storeBit(false)
    .endCell();
}

/**
 * A deploying v4r2 request with its own send mode per message (the driver always signs
 * `SEND_MODE`), from the test key's wallet.
 */
function v4Request(
  t: ReturnType<typeof tonNode>,
  messages: readonly (readonly [number, MessageRelaxed])[],
): { readonly boc: string; readonly hashNorm: string } {
  const contract = WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(PUBLIC_KEY, 'hex'),
  });
  expect(contract.address.toRawString()).toBe(testWallet('v4r2', TESTNET));
  const signing = beginCell()
    .storeUint(contract.walletId, 32)
    .storeUint(Math.floor(t.clock.now() / 1000) + 60, 32)
    .storeUint(0, 32)
    .storeUint(0, 8);
  for (const [mode, message] of messages) {
    signing.storeUint(mode, 8).storeRef(beginCell().store(storeMessageRelaxed(message)));
  }
  const cell = signing.endCell();
  const signature = ed25519.sign(cell.hash(), Buffer.from(KEY, 'hex'));
  const body = beginCell()
    .storeBuffer(Buffer.from(signature))
    .storeSlice(cell.beginParse())
    .endCell();
  const message = beginCell()
    .store(storeMessage(external({ to: contract.address, body, init: contract.init })))
    .endCell();
  return {
    boc: message.toBoc().toString('base64'),
    hashNorm: Buffer.from(normalizedHash(message)).toString('hex'),
  };
}

/**
 * A deploying v5r1 request with its own send mode per action (the driver always signs
 * `SEND_MODE`, which carries +2), from the test key's wallet.
 */
function w5Request(
  t: ReturnType<typeof tonNode>,
  actions: readonly (readonly [number, MessageRelaxed])[],
): { readonly boc: string; readonly hashNorm: string } {
  const key = Buffer.from(PUBLIC_KEY, 'hex');
  const contract = WalletContractV5R1.create({
    publicKey: key,
    walletId: {
      networkGlobalId: TESTNET,
      context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 },
    },
  });
  expect(contract.address.toRawString()).toBe(testWallet('v5r1', TESTNET));
  const identity = resolveIdentity({ ton: { version: 'v5r1' } }, TESTNET);
  const list = beginCell()
    .store(
      storeOutList(actions.map(([mode, outMsg]) => ({ type: 'sendMsg', mode, outMsg }))),
    )
    .endCell();
  const signing = beginCell()
    .storeUint(OP.w5SignedExternal, 32)
    .storeInt(walletIdOf(identity, key), 32)
    .storeUint(Math.floor(t.clock.now() / 1000) + 60, 32)
    .storeUint(0, 32)
    .storeMaybeRef(list)
    .storeBit(false);
  const signature = ed25519.sign(signing.endCell().hash(), Buffer.from(KEY, 'hex'));
  const body = signing.storeBuffer(Buffer.from(signature)).endCell();
  const message = beginCell()
    .store(storeMessage(external({ to: contract.address, body, init: contract.init })))
    .endCell();
  return {
    boc: message.toBoc().toString('base64'),
    hashNorm: Buffer.from(normalizedHash(message)).toString('hex'),
  };
}
