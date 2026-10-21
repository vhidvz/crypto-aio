// Runs test/integration/evm-local.test.ts, the EVM write path, against a local development
// node: Foundry's anvil from the `@foundry-rs/anvil` devDependency, on a free loopback port.
// It starts the node, waits for it to answer, runs the suite with CRYPTO_AIO_IT_EVM_LOCAL_URL
// set, and stops the node, whatever the outcome; the exit code is the suite's.
//
//   pnpm test:evm-local                 # every test, with ethers and web3
//   pnpm test:evm-local -t reorg        # further arguments go to jest
//
// With CRYPTO_AIO_IT_EVM_LOCAL_URL already set, it starts nothing and runs the suite against
// that node instead.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const SUITE = 'test/integration/evm-local.test.ts';
/** How long the node may take to answer its first request. */
const STARTUP_MS = 30_000;

/** A port the system has just handed out, so free for the node to take. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Whether the node at `url` answers `eth_chainId`. */
async function answers(url) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return typeof (await response.json()).result === 'string';
  } catch {
    return false;
  }
}

/** Starts anvil through its package's own launcher, which picks the platform binary. */
async function startAnvil() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const launcher = require.resolve('@foundry-rs/anvil/bin.mjs');
  const anvil = spawn(
    process.execPath,
    [launcher, '--host', '127.0.0.1', '--port', String(port), '--quiet'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Kept to explain a node that never answers; the rest of its output is dropped.
  let output = '';
  const keep = (chunk) => {
    output = (output + chunk).slice(-4_096);
  };
  anvil.stdout.on('data', keep);
  anvil.stderr.on('data', keep);
  let exited = false;
  anvil.on('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + STARTUP_MS;
  while (!(await answers(url))) {
    if (exited || Date.now() > deadline) {
      anvil.kill('SIGTERM');
      throw new Error(`anvil did not start at ${url}:\n${output}`);
    }
    await delay(100);
  }
  const stop = () =>
    new Promise((resolve) => {
      if (exited) return resolve();
      anvil.once('exit', () => resolve());
      // The launcher passes SIGTERM on to the node, then exits.
      anvil.kill('SIGTERM');
    });
  return { url, stop };
}

function runSuite(url) {
  return new Promise((resolve) => {
    const jest = spawn(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--coverage=false',
        SUITE,
        ...process.argv.slice(2),
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, CRYPTO_AIO_IT_EVM_LOCAL_URL: url },
      },
    );
    jest.on('exit', (code) => resolve(code ?? 1));
  });
}

const given = process.env.CRYPTO_AIO_IT_EVM_LOCAL_URL;
if (given) {
  process.exitCode = await runSuite(given);
} else {
  const node = await startAnvil();
  // An interrupted run still stops the node.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void node.stop().then(() => process.exit(1));
    });
  }
  try {
    console.log(`anvil answers at ${node.url}`);
    process.exitCode = await runSuite(node.url);
  } finally {
    await node.stop();
  }
}
