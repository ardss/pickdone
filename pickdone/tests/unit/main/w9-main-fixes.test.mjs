/* W9 verified-bug fixes (2026-10-26):
 *   1. P2 db-tomato-ops.tomatoUpdateById: a patch carrying its own tomatoId used to override
 *      the UPDATE's @tomatoId WHERE binding (built from r.tomatoId after the merge) — the op
 *      silently rewrote a DIFFERENT ledger row. Regression: patch.tomatoId must be ignored;
 *      the TARGET row is updated, every other row untouched.
 *   2. P2 handlers/system.js data:relocate failure branch: the re-arm gate tested the always-true
 *      `ctx.dbm && ctx.dbm.init` instead of probing the re-initialized handle. Regression: a
 *      failed re-init must NOT restart the external db watch; a healthy re-init must.
 * Run: node --test tests/unit/main/w9-main-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w9-main-'))
process.env.TODO_DB_DIR = TMP // log-isolation: keep electron-log writes inside the temp dir

/* ---------------- narrow module stubbing helper (d13/d15 pattern) ---------------- */
let moduleStubs = null
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (moduleStubs && Object.prototype.hasOwnProperty.call(moduleStubs, request)) return moduleStubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })
function withStubs (stubs, fn) {
  const prev = moduleStubs
  moduleStubs = stubs ? { ...moduleStubs, ...stubs } : prev
  try { return fn() } finally { moduleStubs = prev }
}

const electronStub = {
  Notification: class { show () {} },
  shell: { openPath: async () => '', openExternal: async () => '' },
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 })
  },
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test', getLocale: () => 'en-US', on () {}, whenReady: () => Promise.resolve() }
}
// 'electron' stays stubbed for the WHOLE file: the real npm electron shim exports a path string,
// and once origLoad caches it every later require gets the poisoned cache. system.js's own
// requires (updater, export-xlsx) touch electron at module top.
moduleStubs = { electron: electronStub }

/* ---------- fix 1 (P2): patch.tomatoId must not hijack the WHERE binding ---------- */
const db = require_('../../../src/main/db.js')

function seedRec (over) {
  return Object.assign({
    tomatoId: 'w9_t_' + Math.random().toString(36).slice(2),
    endTime: new Date('2026-10-20T10:00:00').getTime(),
    focus: '', focusTaskId: null, focusDuration: 25,
    rest: 5, restDuration: 5, succeed: true, manual: false,
    status: 'local', abandonReason: ''
  }, over)
}

test('W9 1: tomatoUpdateById ignores patch.tomatoId — target updated, sibling untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w9-ledger-'))
  db.init(dir)
  const t0 = new Date('2026-10-20T10:00:00').getTime()
  db.call('tomatoAppendMany', [
    seedRec({ tomatoId: 'w9_target', endTime: t0, focusDuration: 25 }),
    seedRec({ tomatoId: 'w9_sibling', endTime: t0 + 600e3, focusDuration: 30 })
  ])
  // The poison: the patch carries the SIBLING's id. Before the fix, r.tomatoId from the merged
  // rec overrode the WHERE binding and the sibling row got the target's patch.
  const ok = db.call('tomatoUpdateById', { tomatoId: 'w9_target', patch: { tomatoId: 'w9_sibling', focusDuration: 99, focusTaskId: 'tid_w9' } })
  assert.equal(ok, true, 'update must succeed on the target row')
  const target = db.call('tomatoAll').find(x => x.tomatoId === 'w9_target')
  const sibling = db.call('tomatoAll').find(x => x.tomatoId === 'w9_sibling')
  assert.ok(target, 'target row must still exist under its own id (not renamed by the patch)')
  assert.ok(sibling, 'sibling row must still exist under its own id')
  assert.equal(target.focusDuration, 99, 'patch landed on the TARGET row')
  assert.equal(target.focusTaskId, 'tid_w9')
  assert.equal(sibling.focusDuration, 30, 'sibling row untouched (old bug rewrote it)')
  assert.equal(sibling.focusTaskId, null)
})

/* ---------- fix 2 (P2): failed re-init must not restart the external db watch ---------- */

function makeWatchStub () {
  const calls = { stopped: 0, restarted: 0 }
  return { calls, module: { stopLatestDbWatch: () => { calls.stopped++ }, restartLatestDbWatch: () => { calls.restarted++ } } }
}

function makeCtx (dbm) {
  const MAIN = { webContents: { id: 'w9-main' }, isDestroyed: () => false }
  return {
    ctx: {
      isLocked: () => false,
      allowWithinRate: () => true,
      i18n: { mt: () => 'x' },
      app: { getPath: () => TMP },
      getMainWindow: () => MAIN,
      isSafeExternal: () => true,
      dbm
    },
    e: { sender: MAIN.webContents }
  }
}

const systemHandlers = withStubs({ '../updater': { on () {}, checkUpdates: async () => {} } }, () => require_('../../../src/main/handlers/system.js'))

async function runRelocateFailure (dbm) {
  const watch = makeWatchStub()
  const dlStub = { validateTarget: () => ({ ok: true, target: path.join(TMP, 'tgt') }), migrateData: async () => ({ ok: false, error: 'injected migration failure' }) }
  // data-location.cjs and external-db-watch are required LAZILY inside the async handler body,
  // so the stub window must stay open across the await (manual set/restore, not withStubs).
  const prevTodoDb = process.env.TODO_DB_DIR
  const prevTodoUdd = process.env.TODO_USER_DATA_DIR
  delete process.env.TODO_DB_DIR; delete process.env.TODO_USER_DATA_DIR // pass the isolation guard
  moduleStubs = { ...moduleStubs, '../data-location.cjs': dlStub, '../external-db-watch': watch.module }
  try {
    const { ctx, e } = makeCtx(dbm)
    const sys = systemHandlers(ctx)
    const res = await sys['data:relocate'](e, { targetDir: path.join(TMP, 'tgt') })
    return { res, watch }
  } finally {
    moduleStubs = { electron: electronStub }
    if (prevTodoDb !== undefined) process.env.TODO_DB_DIR = prevTodoDb
    if (prevTodoUdd !== undefined) process.env.TODO_USER_DATA_DIR = prevTodoUdd
  }
}

test('W9 2a: failed migration + FAILED re-init (probe throws) does NOT restart the watch', async () => {
  let initCalls = 0
  const dbm = {
    close () {},
    init () { initCalls++; throw new Error('injected re-init failure') },
    call () { throw new Error('dead handle') }
  }
  const { res, watch } = await runRelocateFailure(dbm)
  assert.equal(res.ok, false, 'relocate must report the migration failure')
  assert.match(res.error, /injected migration failure/)
  assert.equal(initCalls, 1, 're-init attempted once')
  assert.equal(watch.calls.stopped, 1, 'watch stopped before close, as before')
  assert.equal(watch.calls.restarted, 0, 'old bug re-armed over a dead handle; must NOT restart')
})

test('W9 2b: failed migration + SUCCESSFUL re-init (getMeta probe answers) restarts the watch', async () => {
  const dbm = {
    close () {},
    init () { /* healthy re-init */ },
    call (op, k) {
      assert.equal(op, 'getMeta')
      assert.equal(k, 'schemaVersion')
      return '7'
    }
  }
  const { res, watch } = await runRelocateFailure(dbm)
  assert.equal(res.ok, false)
  assert.equal(watch.calls.stopped, 1)
  assert.equal(watch.calls.restarted, 1, 'healthy handle must be re-armed (CLI write detection stays alive)')
})
