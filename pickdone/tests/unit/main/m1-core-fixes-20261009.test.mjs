/* m1 round (2026-10-09) — main-process core domain fixes:
 *   1. P1 security-lock: a quit-window render-process-gone must not arm the rebuild whose failed
 *      data: URL load would wipe the user's lock password (lockLoadFailedFallback).
 *   2. P2 scheduler.scheduleOne: a past MAIN reminder with a FUTURE offset instance must still be
 *      scheduled by the write-triggered fast path (the old guard returned early and dropped it).
 *   3. P2 scheduler.reloadAll: a transient queryTodos failure must degrade to warn + keep old
 *      timers, not throw (boot used to escalate it to showErrorBox + exit).
 *   4. P3 db.bumpSnow: minutes clamped to 0 = a true no-op — no row touch / oplog / sync kick.
 *   5. P2 tomato-session: startup compensation dedups against renderer-salted abandon ids
 *      (tmt_a_<startedAt>_<salt>) so one focus cannot land as two abandon rows.
 * Run: node --test tests/unit/main/m1-core-fixes-20261009.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* ================= fix 1 (P1): quit-state guard on the lock-window self-heal ================= */
function makeElectronStub (constructed) {
  const fakeWC = () => {
    const handlers = {}
    return {
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      once: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      send: () => {},
      emit: (ev, ...a) => { for (const fn of handlers[ev] || []) fn(...a) },
      setWindowOpenHandler: () => ({ action: 'deny' })
    }
  }
  return {
    BrowserWindow: class {
      constructor () {
        this.webContents = fakeWC()
        this.destroyed = false
        constructed.push(this)
      }

      isDestroyed () { return this.destroyed }
      focus () {}
      loadURL () { return Promise.resolve() }
      on () {}
      destroy () { this.destroyed = true }
    }
  }
}

function createLockFresh (electron, extraDeps) {
  const require2 = createRequire(import.meta.url)
  const Module = require2('module')
  const resolved = require2.resolve('../../../src/main/security-lock.js')
  delete require2.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron
    return origLoad.call(this, request, parent, isMain)
  }
  const { createSecurityLock: createFresh } = require2('../../../src/main/security-lock.js')
  Module._load = origLoad
  return createFresh({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => ({ enableSecurityLock: true, securityLockPassword: 'plain:secret' }),
    writeConfig: p => extraDeps.configWrites.push(p),
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} },
    ...extraDeps
  })
}

test('m1[1a]: render-process-gone during quit does NOT rebuild and does NOT wipe the lock password', async () => {
  const constructed = []
  const configWrites = []
  const lock = createLockFresh(makeElectronStub(constructed), {
    configWrites,
    isQuitting: () => true
  })
  lock.lockAppNow()
  assert.equal(constructed.length, 1, 'one lock window built')
  const win = constructed[0]
  win.webContents.emit('render-process-gone', null, { reason: 'crashed', exitCode: 1 })
  await new Promise(r => setTimeout(r, 400)) // past the 300ms rebuild arm window
  assert.equal(constructed.length, 1, 'no rebuild while quitting (old code armed lockAppNow here)')
  assert.equal(configWrites.length, 0, 'the disable-lock + password-wipe fallback must never fire on quit teardown')
  assert.equal(lock.isLocked(), true, 'locking intent is untouched')
})

test('m1[1b]: crash while NOT quitting still rebuilds (guard does not over-block)', async () => {
  const constructed = []
  const configWrites = []
  let quitting = false
  const lock = createLockFresh(makeElectronStub(constructed), {
    configWrites,
    isQuitting: () => quitting
  })
  lock.lockAppNow()
  constructed[0].webContents.emit('render-process-gone', null, { reason: 'crashed', exitCode: 1 })
  await new Promise(r => setTimeout(r, 400))
  assert.equal(constructed.length, 2, 'rebuild happened when the app is not quitting')
  assert.equal(configWrites.length, 0)
})

test('m1[1c]: quit starting during the 300ms arm window also abandons the rebuild', async () => {
  const constructed = []
  const configWrites = []
  let quitting = false
  const lock = createLockFresh(makeElectronStub(constructed), {
    configWrites,
    isQuitting: () => quitting
  })
  lock.lockAppNow()
  constructed[0].webContents.emit('render-process-gone', null, { reason: 'crashed', exitCode: 1 })
  quitting = true // quit begins inside the arm window, before the timer fires
  await new Promise(r => setTimeout(r, 400))
  assert.equal(constructed.length, 1, 'the armed rebuild timer checked the quit state and gave up')
  assert.equal(configWrites.length, 0, 'and no fallback wiped the config either')
})

/* ================= fix 2 (P2): scheduleOne keeps future offset instances ================= */
const scheduler = require('../../../src/main/scheduler.js')

test('m1[2a]: past main reminder + future offset → scheduleOne still schedules the offset', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const todo = { taskId: 'm1_off', reminderTime: now - 60_000, reminderOffsets: [-10, 10], reminderExtra: [], delete: false, complete: false }
  scheduler.scheduleOne(todo)
  const keys = [...scheduler._jobs.keys()]
  assert.deepEqual(keys, ['m1_off:10'], 'the future +10min offset instance is scheduled; past instances are no-ops')
  scheduler._clearStateForTest()
})

test('m1[2b]: all instances past (main + offsets + extras) → scheduleOne returns without timers', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const todo = { taskId: 'm1_allpast', reminderTime: now - 60_000, reminderOffsets: [-30, -10], reminderExtra: [now - 120_000], delete: false, complete: false }
  scheduler.scheduleOne(todo)
  assert.equal(scheduler._jobs.size, 0, 'nothing future → nothing scheduled (guard returns)')
  // future extra only (no main reminder): still scheduled — old guard required no reminderExtra
  const t2 = { taskId: 'm1_extra', reminderTime: 0, reminderOffsets: [], reminderExtra: [now + 5_000], delete: false, complete: false }
  scheduler.scheduleOne(t2)
  assert.equal(scheduler._jobs.size, 1, 'future absolute extra is scheduled')
  scheduler._clearStateForTest()
})

/* ================= fix 3 (P2): reloadAll survives a transient queryTodos failure ================= */
const mkDb = (todos, opts = {}) => {
  const meta = new Map()
  return {
    getMeta: k => (meta.has(k) ? meta.get(k) : null),
    setMeta: ([k, v]) => { meta.set(k, String(v)) },
    queryTodos: () => {
      if (opts.throwQuery) throw new Error('SQLITE_BUSY: database is locked')
      return typeof todos === 'function' ? todos() : todos
    }
  }
}

test('m1[3]: queryTodos failure → reloadAll does not throw and keeps the previous timers', () => {
  scheduler._clearStateForTest()
  const live = [{ taskId: 'm1_keep', reminderTime: Date.now() + 3600_000, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }]
  scheduler.reloadAll(mkDb(live))
  assert.equal(scheduler._jobs.size, 1, 'sanity: future timer scheduled')
  const before = [...scheduler._jobs.keys()]
  // transient read failure (SQLITE_BUSY at boot): must degrade, not propagate to index.js → exit
  assert.doesNotThrow(() => scheduler.reloadAll(mkDb(null, { throwQuery: true })), 'reloadAll swallows the query failure')
  assert.deepEqual([...scheduler._jobs.keys()], before, 'old timers are untouched by the failed rebuild')
  // a later healthy rebuild still works (fingerprint was not advanced by the failed round)
  scheduler.reloadAll(mkDb([]))
  assert.equal(scheduler._jobs.size, 0, 'next healthy rebuild tears down as usual')
  scheduler._clearStateForTest()
})

/* ================= fix 4 (P3): bumpSnow m=0 is a true no-op ================= */
const dbmod = require('../../../src/main/db.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-bumpsnow-'))
dbmod.init(dir)

const seed = over => Object.assign({
  taskId: 'm1_bump_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

test('m1[4a]: bumpSnow minutes=0 returns ok without touching the row', () => {
  const t = seed({})
  dbmod.call('upsert', t)
  const before = dbmod.call('getById', t.taskId)
  const r = dbmod.call('bumpSnow', { taskId: t.taskId, minutes: 0 })
  assert.deepEqual(r, { ok: true, minutes: 0 }, 'm=0 short-circuits with ok:true')
  const after = dbmod.call('getById', t.taskId)
  assert.equal(after.estimate, before.estimate, 'no focus credit change')
  assert.equal(after.updatedAt, before.updatedAt, 'updatedAt untouched (old code re-stamped it, amplifying oplog+sync)')
})

test('m1[4b]: bumpSnow minutes=0 with dedupKey stamps nothing', () => {
  const t = seed({})
  dbmod.call('upsert', t)
  const before = dbmod.call('getById', t.taskId)
  const r = dbmod.call('bumpSnow', { taskId: t.taskId, minutes: 0, dedupKey: 'sess-1' })
  assert.deepEqual(r, { ok: true, minutes: 0 })
  const after = dbmod.call('getById', t.taskId)
  assert.equal(after.updatedAt, before.updatedAt, 'no row touch on the dedup path either')
})

test('m1[4c]: bumpSnow m>0 behavior unchanged', () => {
  const t = seed({})
  dbmod.call('upsert', t)
  const r = dbmod.call('bumpSnow', { taskId: t.taskId, minutes: 25 })
  assert.deepEqual(r, { ok: true, minutes: 25 })
  assert.equal(dbmod.call('getById', t.taskId).estimate, 25, 'credit lands as before')
  const r2 = dbmod.call('bumpSnow', { taskId: 'm1_missing', minutes: 0 })
  assert.deepEqual(r2, { ok: true, minutes: 0 }, 'm=0 stays ok even for a missing task (no row to touch)')
})

/* ================= fix 5 (P2): startup compensation dedups salted renderer abandon ids ================= */
const { createTomatoSession, reconcileDecision } = require('../../../src/main/tomato-session.js')

function makeDb () {
  const meta = new Map()
  const tomatoes = []
  const calls = []
  const call = (op, p) => {
    calls.push([op, p])
    if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
    if (op === 'setMeta') { meta.set(Array.isArray(p) ? p[0] : p, Array.isArray(p) ? p[1] : null); return true }
    if (op === 'deleteMeta') return meta.delete(p)
    if (op === 'getById') { const r = tomatoes.find(t => t.taskId === p); return r ? { ...r } : null }
    if (op === 'tomatoAll') return tomatoes.map(r => ({ ...r }))
    if (op === 'tomatoAppendMany') { tomatoes.push(...(Array.isArray(p) ? p : [p]).map(r => ({ ...r }))); return { accepted: 1, rejected: [] } }
    throw new Error('unexpected op ' + op)
  }
  return { call, calls, meta, tomatoes }
}

const expiredStart = { transition: 'start', status: 'startTomatoTime', startedAt: Date.now() - 2 * 60 * 60_000, attachTaskId: 7, tomatoTime: 25, restTime: 5 }

test('m1[5a]: existing salted abandon row for the same startedAt → no duplicate append', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  s.applyTransition(expiredStart)
  // renderer managed to book its own salted abandon before dying (mintTomatoId → tmt_a_<ts>_<salt>)
  db.tomatoes.push({ tomatoId: 'tmt_a_' + expiredStart.startedAt + '_xk29fz' })
  const d = s.reconcile()
  assert.equal(d.action, 'book')
  assert.equal(db.tomatoes.length, 1, 'no second abandon row for the same focus')
  assert.equal(db.meta.has('tomatoRunningSession'), false, 'durable row still cleared (phase is recorded)')
  const appends = db.calls.filter(([op]) => op === 'tomatoAppendMany')
  assert.equal(appends.length, 0, 'tomatoAppendMany never called')
})

test('m1[5b]: no pre-existing record → compensation appends as before; failed dedup query degrades to append', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  s.applyTransition(expiredStart)
  s.reconcile()
  assert.equal(db.tomatoes.length, 1, 'the dead focus is still booked exactly once')
  assert.ok(db.tomatoes[0].tomatoId.startsWith('tmt_a_' + expiredStart.startedAt), 'deterministic id kept')

  // dedup query failure must not block the booking (availability beats dedup)
  const db2 = makeDb()
  db2.tomatoes.push({ tomatoId: 'unrelated' })
  const s2 = createTomatoSession({
    call: (op, p) => { if (op === 'tomatoAll') throw new Error('db gone'); return db2.call(op, p) }
  })
  s2.applyTransition(expiredStart)
  s2.reconcile()
  assert.equal(db2.tomatoes.length, 2, 'append proceeds when the dedup read fails')
})
