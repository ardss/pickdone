/**
 * Worker body for relay-413-drain.test.mjs.
 *
 * The fetch() global keeps an undici keep-alive socket (plus its timer handle) in the
 * calling process. Under tests/run-all.mjs the per-file child runs with
 * --test-force-exit, and that still-closing handle trips the win32 libuv teardown
 * assert (`!(handle->flags & UV_HANDLE_CLOSING)`, exitCode 3221226505 / 0xC0000409)
 * AFTER the test has passed — the file then reads as a random failure even though the
 * protocol behavior is green. Running the protocol exercise in a worker thread means
 * every client/server handle dies with the worker: the runner process exits clean.
 */
import { parentPort } from 'node:worker_threads'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))

const bigJsonBody = JSON.stringify({ account: 'acc', device: 'dev', items: [{ opId: 'op-big', envelope: 'x'.repeat(9 * 1024 * 1024) }] })

const relay = createRelay(memoryStore())
const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
const base = `http://127.0.0.1:${server.address().port}`
const failures = []
try {
  // 1) oversized upload: must be a readable 413, never a socket-level failure.
  //    Before the 2026-10-10 fix this rejected with FetchError/ECONNRESET while the
  //    client was still writing the body.
  const res = await fetch(base + '/v1/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bigJsonBody
  })
  if (res.status !== 413) failures.push(`oversized POST: expected 413, got ${res.status}`)
  const errBody = await res.json().catch(e => { failures.push('413 body unreadable: ' + e.message); return {} })
  if (errBody.error !== 'request body too large') failures.push(`413 body error: ${JSON.stringify(errBody).slice(0, 120)}`)

  // 2) the same server keeps serving small requests after the 413 — the connection
  //    handling did not wedge the listener or leak a half-response.
  const reg = await fetch(base + '/v1/device/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'acc', device: 'dev' })
  })
  if (reg.status !== 200) failures.push(`register after 413: expected 200, got ${reg.status}`)
  const regBody = await reg.json().catch(e => { failures.push('register body unreadable: ' + e.message); return {} })
  if (!regBody.device?.deviceSecret) failures.push('register still works after the 413 (deviceSecret missing)')
} catch (e) {
  failures.push('unexpected: ' + (e && e.cause ? `${e.message} (${e.cause})` : e.message))
} finally {
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
// Report, then hard-exit shortly after: this throwaway worker still holds undici client
// handles whose graceful teardown trips the win32 libuv assert (same bug the worker
// boundary avoids for the runner child) — an explicit exit after the report has been
// handed to the message port is the whole point of the worker boundary.
parentPort.postMessage({ failures })
setTimeout(() => process.exit(failures.length ? 1 : 0), 150)
