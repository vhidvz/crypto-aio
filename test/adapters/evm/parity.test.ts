import { secp256k1 } from '@noble/curves/secp256k1';
import { Wallet } from 'ethers';
import type { EvmClient, EvmTxFields } from '../../../src/adapters/evm/types';
import { makeClient, nodeTransport } from './support/harness';
import { KEY, RECIPIENT, signDigest } from './support/vectors';

/** A deterministic spread of transactions: both types, chain ids, sizes and payloads. */
function* fieldMatrix(): Generator<EvmTxFields> {
  const data = [
    '0x',
    `0xa9059cbb${'00'.repeat(12)}${RECIPIENT.slice(2)}${'00'.repeat(31)}2a`,
    `0x${'ff'.repeat(300)}`,
  ];
  let i = 0;
  for (const chainId of [1n, 56n, 42161n, 11155111n, 560048n]) {
    for (const nonce of [0n, 1n, 127n, 128n, 65_536n]) {
      for (const value of [0n, 1n, 10n ** 18n, 2n ** 96n]) {
        const base = {
          chainId,
          nonce,
          to: RECIPIENT,
          value,
          data: data[i++ % data.length] as string,
          gasLimit: 21_000n + nonce,
        };
        yield {
          ...base,
          type: 'eip1559',
          maxFeePerGas: 30_000_000_000n + (value % 7n),
          maxPriorityFeePerGas: nonce,
        };
        yield { ...base, type: 'legacy', gasPrice: 1n + (value % 1_000_003n) };
      }
    }
  }
}

function clients(chainId: bigint): [EvmClient, EvmClient] {
  const { transport } = nodeTransport({ chainId });
  return [
    makeClient('ethers', transport, chainId),
    makeClient('web3', transport, chainId),
  ];
}

describe('EthersClient and Web3Client parity', () => {
  it('produce byte-identical payloads, digests, signed bytes and hashes', () => {
    let count = 0;
    for (const fields of fieldMatrix()) {
      const [a, b] = clients(fields.chainId);
      const digest = a.unsignedHash(fields);
      const signature = signDigest(digest);
      expect([
        b.serializeUnsigned(fields),
        b.unsignedHash(fields),
        b.serializeSigned(fields, signature),
      ]).toEqual([
        a.serializeUnsigned(fields),
        digest,
        a.serializeSigned(fields, signature),
      ]);
      count += 1;
    }
    expect(count).toBe(200);
  });

  it('derive identical addresses and ABI data', () => {
    const [a, b] = clients(1n);
    for (let i = 1; i <= 20; i++) {
      const key = secp256k1.getPublicKey(BigInt(i) * 7_919n, i % 2 === 0);
      expect(b.addressFromPublicKey(key)).toBe(a.addressFromPublicKey(key));
      const address = a.addressFromPublicKey(key);
      expect(b.checksum(address.toLowerCase())).toBe(a.checksum(address.toLowerCase()));
      expect(b.abi.encodeTransfer(address, BigInt(i) ** 20n)).toBe(
        a.abi.encodeTransfer(address, BigInt(i) ** 20n),
      );
      expect(b.abi.encodeBalanceOf(address)).toBe(a.abi.encodeBalanceOf(address));
    }
    // An OP Stack payload, built by a client on that network (R61).
    const payload = clients(10n)[0].serializeUnsigned({
      type: 'eip1559',
      chainId: 10n,
      nonce: 1n,
      to: RECIPIENT,
      value: 1n,
      data: '0x',
      gasLimit: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    expect(b.abi.encodeGetL1Fee(payload)).toBe(a.abi.encodeGetL1Fee(payload));
    expect(b.abi.transferTopic).toBe(a.abi.transferTopic);
  });

  it('normalize the same node answers into equal plain data', async () => {
    const t = nodeTransport({ chainId: 11155111n, l1Fee: 3n });
    const wallet = new Wallet(`0x${KEY}`);
    t.node.fund(wallet.address, 10n ** 18n);
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: 11155111n,
      nonce: 0,
      to: RECIPIENT,
      value: 5n,
      gasLimit: 21_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const tags = { purpose: 'read', retry: 'safe' } as const;
    const read = async (client: EvmClient) => {
      const block = await client.getBlock(1n, tags);
      return {
        missing: await client.getTransaction(`0x${'00'.repeat(32)}`, tags),
        block,
        latest: await client.getBlock('latest', tags),
        full: await client.getBlockWithTransactions(1n, tags),
        receipt: await client.getReceipt(block?.transactions[0] ?? '', tags),
        history: await client.feeHistory(1, 'latest', [10, 50], tags),
        nonce: await client.getTransactionCount(wallet.address, 'finalized', tags),
      };
    };
    const [a, b] = [
      makeClient('ethers', t.transport, 11155111n),
      makeClient('web3', t.transport, 11155111n),
    ];
    await t.run(a.sendRawTransaction(raw, { purpose: 'broadcast' }));
    t.node.mine(3);
    expect(await t.run(read(b))).toEqual(await t.run(read(a)));
  });
});
