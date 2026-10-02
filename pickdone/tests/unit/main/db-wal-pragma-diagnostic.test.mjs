import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// enc-pragma-wal-diagnostic-not-shipped (P3): applyConnPragmas wrapped journal_mode/busy_timeout
// in bare try/catch — WAL non-application was silent. Fix reads both pragmas back and log.errors
// when WAL is not active. This file MUST inject its stubs into require.cache BEFORE requiring
// db.js (loadDriver memoizes the vendor driver into a module-level var and db.js binds its logger
// at module load), so it runs in its own node --test process.

const require = createRequire(import.meta.url)

// 1) electron-log recording stub (db.js resolves electron-log from node_modules in plain Node)
const elogPath = require.resolve('electron-log')
const logCalls = { warn: [], error: [] }
require.cache[elogPath] = {
  id: elogPath, filename: elogPath, loaded: true,
  exports: {
    info: () => {}, warn: (...a) => logCalls.warn.push(a.map(String).join(' ')), error: (...a) => logCalls.error.push(a.map(String).join(' ')),
    transports: { file: {}, console: {} },
    scope: () => ({ info () {}, warn () {}, error () {} })
  }
}

// 2) vendor driver stub: journal_mode assignments are silently dropped (simulating a handle
//    where WAL cannot engage) — read-back then sees non-WAL. The vendor export is a factory
//    FUNCTION (db.js does `new loadDriver()(file)`), so the stub mirrors that shape.
const vendorPath = require.resolve('../../../vendor/better-sqlite3-multiple-ciphers')
const RealDatabase = require(vendorPath)
// plain function (callable without `new`, like the real vendor Database): db.js reaches it via
// `new loadDriver()(file)` where `new loadDriver()` returns this function and `(file)` calls it.
function NoWalDatabase (filename, options) {
  const inst = new RealDatabase(filename, options)
  const orig = inst.pragma.bind(inst)
  inst.pragma = (source, params) =>
    /^\s*journal_mode\s*=/i.test(String(source)) ? orig('journal_mode', params) : orig(source, params)
  return inst
}
require.cache[vendorPath] = { id: vendorPath, filename: vendorPath, loaded: true, exports: NoWalDatabase }

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-wal-diag-'))
const db = require('../../../src/main/db')
db.init(process.env.TODO_DB_DIR)

test('WAL not active is surfaced through log.error (was silent before the fix)', () => {
  const p = db.__connPragmasForTests()
  assert.ok(p, 'pragma introspection hook exposed')
  assert.notEqual(String(p.journalMode).toLowerCase(), 'wal', 'stubbed driver really dropped WAL')

  const hit = logCalls.error.find(e => e.includes('[TodoDB] WAL mode not active'))
  assert.ok(hit, 'log.error fired for WAL non-application, got: ' + JSON.stringify(logCalls.error))
  assert.ok(/journal_mode=/.test(hit), 'diagnostic carries the actual journal_mode value')
})
