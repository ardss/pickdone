/**
 * 2026-10-10 — relay 413 body-limit response must be readable, not ECONNRESET.
 *
 * Independent integration loopback finding: POSTing a 9MB body to the relay made the
 * client's fetch fail with ECONNRESET instead of resolving the HTTP 413. Root cause:
 * startRelayServer wrote the 413 from inside req.on('data') while the client was still
 * uploading, then stopped consuming the socket — the unconsumed request body backed up
 * the connection and Node reset it before the client ever read the response.
 *
 * Fix: over-limit is only FLAGGED in the 'data' handler; the body keeps being consumed
 * and DISCARDED (no buffering, O(1) memory), and exactly one 413 is written on req
 * 'end' — after the client finished uploading and can reliably read it.
 *
 * 2026-10-12 isolation: the protocol exercise lives in relay-413-drain.worker.mjs and
 * runs in a WORKER thread. fetch()'s undici keep-alive socket (and its timer handle)
 * survives in the calling process after the test passes; tests/run-all.mjs runs every
 * file with --test-force-exit, and that still-closing handle tripped the win32 libuv
 * teardown assert (exitCode 3221226505 / 0xC0000409) after a green subtest — the file
 * then read as a random failure. Reproduced deterministically: `node --test
 * --test-force-exit` on the pre-isolation file asserts
 * `!(handle->flags & UV_HANDLE_CLOSING)` on every run (3/3), while standalone runs
 * without force-exit never crash — which is why "standalone green" proved nothing. In a
 * worker, every client/server handle dies with the worker thread and the runner child
 * exits clean (16/16 force-exit runs after the fix, 0 asserts).
 *
 * Companion: relay-413-forceexit-teardown.test.mjs spawns this file under
 * --test-force-exit and requires exit code 0 — the discriminating regression for the
 * forced-exit scenario (red 3/3 on the pre-isolation code, green on the isolation).
 *
 * Run: node --test tests/unit/lan-sync/relay-413-drain.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('relay: a 9MB POST resolves as HTTP 413 (not ECONNRESET), and the server stays usable afterwards', async () => {
  const { failures } = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'relay-413-drain.worker.mjs'), { stderr: true })
    let errTail = ''
    let got = false
    worker.stderr.on('data', d => { errTail = (errTail + d).slice(-600) })
    worker.on('message', msg => { got = true; resolve(msg) })
    worker.on('error', reject)
    // only a pre-report exit is a failure — after the message the worker self-exits and a
    // runner-side terminate/force-exit may legitimately surface as a non-zero exit code
    worker.on('exit', code => { if (!got && code !== 0) reject(new Error(`relay-413 worker exited ${code}\nstderr: ${errTail}`)) })
  })
  assert.deepEqual(failures, [], 'worker-reported protocol failures')
})
