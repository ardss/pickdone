/**
 * Worker body for relay-account-rebind-20261013.test.mjs.
 *
 * Same disease as relay-413-drain (2026-10-12 root cause): adapter.enable()'s fetch()
 * keeps an undici keep-alive socket + timer handle in the calling process, and under
 * tests/run-all.mjs the per-file child runs with --test-force-exit — the still-closing
 * handle trips the win32 libuv teardown assert (`!(handle->flags & UV_HANDLE_CLOSING)`,
 * exitCode 3221226505 / 0xC0000409) AFTER the subtest has passed, so the file reads as
 * a deterministic in-suite failure (fail at position ~426 on every full run) while a
 * solo run without force-exit is always green. Worker boundary: every client/server
 * handle dies with the worker thread.
 */
import { parentPort } from 'node:worker_threads'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { createRevisionStore } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-core/causality/merge.mjs')))
const { createRelayAdapter } = createRequire(import.meta.url)('../../../src/main/relay-sync-adapter')

const relay = createRelay(memoryStore())
const server = await startRelayServer(relay, { port: 0 })
const baseUrl = `http://127.0.0.1:${server.address().port}`
const settings = new Map()
const adapter = createRelayAdapter({
  nodeId: 'isolated-rebind-device',
  settingsGet: key => settings.get(key) ?? null,
  settingsPut: (key, value) => settings.set(key, String(value)),
  loadStore: async () => createRevisionStore('isolated-rebind-device'),
  retryMax: 1,
  env: {},
})
const failures = []
try {
  const initial = await adapter.enable({ account: 'account-one', baseUrl })
  assert.equal(initial.hasDeviceSecret, true, initial.lastError || 'registration failed')
  const before = Object.fromEntries(settings)
  await assert.rejects(
    () => adapter.enable({ account: 'account-two', baseUrl }),
    /different account|account switch|rebind|forget/i,
    'changing account with an existing device credential must be explicitly rejected',
  )
  assert.deepEqual(Object.fromEntries(settings), before, 'rejected account change must be atomic')
  await assert.rejects(
    () => adapter.enable({ account: 'account-one', baseUrl, rootKey: 'a'.repeat(64) }),
    /different root key|key rotation|rebind|forget/i,
    'changing the E2E key without an explicit migration must be rejected',
  )
  assert.deepEqual(Object.fromEntries(settings), before, 'rejected key rotation must be atomic')
} catch (e) {
  failures.push('unexpected: ' + (e && e.cause ? `${e.message} (${e.cause})` : e.message))
} finally {
  try { await adapter.stop() } catch { /* already down */ }
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
// Report, then hard-exit shortly after: the throwaway worker itself still holds undici
// client handles whose graceful teardown trips the win32 libuv assert — the explicit
// exit after the report is handed to the message port is the point of the boundary.
parentPort.postMessage({ failures })
setTimeout(() => process.exit(failures.length ? 1 : 0), 150)
