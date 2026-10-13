/**
 * Regression: an existing relay identity (deviceSecret + durable cursor) must not
 * silently rebind to another account, relay origin, or E2E root key — a silent rebind
 * can reuse a wrong bearer token or skip remote-history protection. The adapter must
 * refuse BEFORE any settings writes (atomic rejection).
 *
 * Teardown note (2026-10-14): the drill runs in relay-account-rebind-20261013.worker.mjs
 * — adapter.enable()'s fetch() leaves undici keep-alive handles that trip the win32
 * libuv teardown assert (exitCode 3221226505) under run-all's --test-force-exit AFTER
 * this subtest passes; the worker boundary lets every handle die with the thread
 * (same root cause and fix pattern as lan-sync/relay-413-drain, 2026-10-12).
 *
 * Run: node --test tests/unit/main/relay-account-rebind-20261013.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('existing relay identity cannot silently rebind to another account or encryption key', async () => {
  const { failures } = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'relay-account-rebind-20261013.worker.mjs'), { stderr: true })
    let errTail = ''
    let got = false
    worker.stderr.on('data', d => { errTail = (errTail + d).slice(-600) })
    worker.on('message', msg => { got = true; resolve(msg) })
    worker.on('error', reject)
    worker.on('exit', code => { if (!got && code !== 0) reject(new Error('rebind worker exited ' + code + '\nstderr: ' + errTail)) })
  })
  assert.deepEqual(failures, [], 'worker-reported rebind-guard failures')
})
