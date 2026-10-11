'use strict'
/**
 * Cross-process child runner for the relay outbox regression (real app code only).
 *
 * One invocation = one "device boot": the child re-opens the REAL encrypted SQLite
 * (db.js + vendor better-sqlite3-multiple-ciphers) at --dir, re-inits the REAL relay
 * bootstrap (relay-sync-bootstrap + db-sync-ops), runs ONE op, prints a single JSON
 * line to stdout, and exits. Process death is the restart primitive — the next
 * invocation proves persistence from disk, never from memory.
 *
 * Ops:
 *   enable     {account,baseUrl,rootKey}  -> relaySetEnabled(true) + status
 *   upsert     {taskId,taskContent,createTime,updateTime} -> db.call('upsert')
 *   sync       {}                         -> relaySyncNow (full round: push+pull+apply)
 *   get-all    {}                         -> db.call('getAll')
 *   status     {}                         -> relayGetStatus
 *   probe-enc  {}                         -> todos.db header bytes + db.key presence
 *
 * Usage: node child.cjs --dir <deviceDir> --op <name> [--payload <json>]
 * Exit 0 + last stdout line = JSON result. Any throw -> {ok:false,error} + exit 1.
 */

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function arg (name) {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : null
}

function fail (msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n')
  process.exit(1)
}

const dir = arg('--dir')
const op = arg('--op')
if (!dir || !fs.existsSync(dir)) fail('child: --dir missing or not created: ' + dir)
if (!op) fail('child: --op required')
let payload = {}
try { payload = arg('--payload') ? JSON.parse(arg('--payload')) : {} } catch (e) { fail('child: bad --payload JSON: ' + e.message) }

// Isolation gates BEFORE any app module loads (log-isolation reads these at require time).
process.env.TODO_DB_DIR = dir
process.env.TODO_USER_DATA_DIR = dir

// Repo root = 4 levels up from tests/fixtures/relay-cross-process/
const ROOT = path.join(__dirname, '..', '..', '..')
const req = createRequire(path.join(ROOT, 'package.json'))

async function main () {
  const db = req(path.join(ROOT, 'src', 'main', 'db.js'))
  db.init(dir) // real encrypted SQLite open (migrations/key handling included)

  const bootstrap = req(path.join(ROOT, 'src', 'main', 'relay-sync-bootstrap.js'))
  bootstrap.__test.reset()
  bootstrap.initRelaySync()
  const st = bootstrap.__test.getState()
  if (st && st.adapter) st.adapter.stop() // deterministic: rounds only via explicit `sync`

  const dbSyncOps = req(path.join(ROOT, 'src', 'main', 'db-sync-ops.js'))
  let result
  switch (op) {
    case 'enable':
      result = await dbSyncOps.dispatch('relaySetEnabled', {
        enabled: true, account: payload.account, baseUrl: payload.baseUrl, rootKey: payload.rootKey,
      })
      break
    case 'upsert':
      db.call('upsert', payload.todo)
      result = { upserted: payload.todo.taskId }
      break
    case 'sync':
      result = await dbSyncOps.dispatch('relaySyncNow')
      break
    case 'get-all':
      result = db.call('getAll')
      break
    case 'status':
      result = dbSyncOps.dispatch('relayGetStatus')
      break
    case 'probe-enc': {
      const dbFile = path.join(dir, 'todos.db')
      const keyFile = path.join(dir, 'db.key')
      const fd = fs.openSync(dbFile, 'r')
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      fs.closeSync(fd)
      result = {
        dbFile: fs.existsSync(dbFile),
        keyFile: fs.existsSync(keyFile),
        plaintextHeader: head.toString('latin1') === 'SQLite format 3\0',
        header: head.toString('latin1'),
      }
      break
    }
    default:
      fail('child: unknown op ' + op)
  }
  try { db.close() } catch { /* child exit releases the handle anyway */ }
  // The enable/sync ops re-arm the relay poll loop; process.exit() while its timers/agent
  // socket are live trips libuv's teardown assert (win async.c UV_HANDLE_CLOSING) and the
  // child exits non-zero AFTER printing a valid result. Stop the machinery first.
  try {
    const st2 = bootstrap.__test.getState()
    if (st2 && st2.adapter) st2.adapter.stop()
  } catch { /* best-effort: exit must not depend on teardown */ }
  process.stdout.write(JSON.stringify({ ok: true, op, result }) + '\n')
  process.exit(0)
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, op, error: (e && e.message) || String(e) }) + '\n')
  process.exit(1)
})
