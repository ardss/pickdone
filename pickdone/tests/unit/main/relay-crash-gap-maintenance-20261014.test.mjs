import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'

// Fully synthetic, temporary SQLite + loopback Relay. No real account or task DB.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-crash-gap-'))
process.env.TODO_DB_DIR = root
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const ops = require('../../../src/main/db-sync-ops')
const bootstrap = require('../../../src/main/relay-sync-bootstrap')
const syncApply = require('../../../src/main/sync-apply')
const key = generateAccountRootKey()
const account = 'synthetic-crash-gap'
const dirA = path.join(root, 'A')
const dirB = path.join(root, 'B')
fs.mkdirSync(dirA)
fs.mkdirSync(dirB)

function device(dir) {
  db.init(dir)
  bootstrap.__test.reset()
  bootstrap.initRelaySync()
  const state = bootstrap.__test.getState()
  if (state?.adapter) state.adapter.stop()
}
async function enable(url) {
  const s = await ops.dispatch('relaySetEnabled', { enabled: true, account, baseUrl: url, rootKey: key })
  assert.equal(s.enabled, true)
}
function task(id) {
  return db.call('getAll').find(row => String(row.taskId) === id)
}

test('crash after durable DAG ingest but before business flush must replay into todos', async t => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  const url = 'http://127.0.0.1:' + server.address().port
  const originalFlush = syncApply.flushPendingWrites
  t.after(async () => {
    syncApply.flushPendingWrites = originalFlush
    bootstrap.__test.reset()
    db.close() // Windows keeps SQLite locked until the test closes its own handle.
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  device(dirA)
  await enable(url)
  db.call('upsert', { taskId: 'crash-gap-1', taskContent: 'must survive retry', createTime: 1, updateTime: 100 })
  const pushed = await ops.dispatch('relaySyncNow')
  assert.equal(pushed.ok, true, pushed.error || 'A push failed')

  device(dirB)
  let injected = 0
  // Install BEFORE enabling B: enabling itself may schedule an immediate pull.
  // Keep failure active until we have proved no business row landed.
  syncApply.flushPendingWrites = () => {
    injected++
    throw new Error('INJECTED_AFTER_DAG_BEFORE_BUSINESS')
  }
  try {
    await enable(url)
    const state = bootstrap.__test.getState()
    if (state?.adapter) state.adapter.stop()
    await ops.dispatch('relaySyncNow')
    assert.equal(task('crash-gap-1'), undefined, 'failed flush must not have materialized task')
  } finally {
    syncApply.flushPendingWrites = originalFlush
  }
  assert.ok(injected >= 1, 'failure injection must actually hit business flush')
  assert.equal(task('crash-gap-1'), undefined, 'failed flush must not have materialized task')
  assert.ok(db.call('revisionsList').length > 0, 'DAG revisions were persisted before failed flush')
  // Re-open the same synthetic B DB to prove this survives a durable restart.
  device(dirB)
  assert.equal(ops.dispatch('relayGetStatus').enabled, true, 'relay settings survive B restart')
  const retry = await ops.dispatch('relaySyncNow')
  assert.equal(retry.ok, true, retry.error || 'retry must succeed')
  assert.equal(task('crash-gap-1')?.taskContent, 'must survive retry',
    'durable DAG ingest must not cause retry to skip unfinished business materialization')
})
