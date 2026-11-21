/* W33 maintenance round — agent F2 regression tests.
 *   Fix 1 [P2] tomato-session.js: boot compensation booked wall-clock minutes (up to 600 after a
 *              48h crash/hibernate); bookable focus is now bounded by the phase's own tomatoTime.
 *   Fix 2 [P2] db.js snowDedup cap: an age-only DELETE matched 0 rows when ALL keys were young —
 *              the cap now converges by deleting the oldest excess (value ASC, LIMIT form).
 *   Fix 3 [P3] handlers/system.js: the renderer 'notification' channel had no click route; it now
 *              routes through the scheduler's lock-aware focusMainFromNotification (taskId pass-through).
 *   Fix 4 [P3] tomato-float.js: lastHandshakeAt survived a destroy+rebuild; create() resets it.
 *   Fix 5 [P3] quick-add.js: all display probes failed → x = -240 off-screen; null display now
 *              falls back to positive coordinates near the primary-screen origin.
 *
 * Run: node --test tests/unit/main/w33-maintenance-f2.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
function tmpDir (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'w33-f2-' + tag + '-')) }

/* ---- Fix 1: boot compensation focusDuration ≤ tomatoTime ---- */
const ts = require_('../../../src/main/tomato-session.js')

test('W33 F1: wall-clock far beyond tomatoTime books at most tomatoTime minutes', () => {
  const now = Date.now()
  // startedAt 48h ago, phase budget 25min: the OLD code booked 600 (FOCUS_MAX cap) minutes of
  // phantom focus; the fix books exactly the phase budget.
  const d = ts.reconcileDecision({ status: 'startTomatoTime', startedAt: now - 48 * 3600_000, tomatoTime: 25 }, now)
  assert.equal(d.action, 'book')
  assert.equal(d.focusDuration, 25, 'must book ≤ tomatoTime, not wall-clock/FOCUS_MAX')
})

test('W33 F1: clamp still honors a custom tomatoTime and the 1-minute floor', () => {
  const now = Date.now()
  const d = ts.reconcileDecision({ status: 'startTomatoTime', startedAt: now - 10 * 3600_000, tomatoTime: 90 }, now)
  assert.equal(d.focusDuration, 90)
  const d2 = ts.reconcileDecision({ status: 'startTomatoTime', startedAt: now - 10 * 3600_000, tomatoTime: 0 }, now)
  assert.equal(d2.focusDuration, 25, 'tomatoTime missing → default 25 budget')
  // short overrun: just past the budget → booked minutes still equal the budget, never less than 1
  const d3 = ts.reconcileDecision({ status: 'startTomatoTime', startedAt: now - 26 * 60_000, tomatoTime: 25 }, now)
  assert.equal(d3.action, 'book')
  assert.equal(d3.focusDuration, 25)
})

/* ---- Fix 2: snowDedup cap convergence with all-young keys ---- */
test('W33 F2: a burst of young dedup keys past the cap converges back within the cap', () => {
  process.env.TODO_DB_DIR = tmpDir('db')
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  db.call('upsert', { taskId: 'w33_cap_task', taskContent: 'x', categoryId: null, complete: false, deleted: false })
  // Seed CAP + 300 ALL-YOUNG keys directly (same value shape the bump writes: epoch ms stamp).
  const CAP = 2000
  const rows = []
  for (let i = 0; i < CAP + 300; i++) rows.push(['snowDedup:w33_cap_task:w33-seed-' + i, String(Date.now() - i)]) // young, small age spread
  db.call('setMetaMany', rows)
  const countNow = () => db.prepare ? null : null // (no direct handle; count via meta listing)
  const keys = () => db.call('listMetaKeys', []).filter(k => k.startsWith('snowDedup:'))
  assert.equal(keys().length, CAP + 300, 'seed landed over the cap')
  // One more dedup bump must trigger the prune and converge the count to ≤ CAP.
  const r = db.call('bumpSnow', { taskId: 'w33_cap_task', minutes: 5, dedupKey: 'w33-prune-trigger' })
  assert.deepEqual(r, { ok: true, minutes: 5 })
  const after = keys().length
  assert.ok(after <= CAP, 'count must converge to ≤ CAP, got ' + after)
  assert.ok(after >= 1, 'the bump that triggered the prune must survive (newest stamp)')
  assert.ok(keys().includes('snowDedup:w33_cap_task:w33-prune-trigger'), 'fresh key is never the one pruned')
  void countNow
})

/* ---- Fix 3: renderer 'notification' channel click route ---- */
test('W33 F3: notification click mounts the handler and passes taskId to the scheduler focus path', () => {
  const Module = require_('module')
  const resolved = require_.resolve('../../../src/main/handlers/system.js')
  delete require_.cache[resolved]
  const clicks = [] // [handler] attached per notification
  const shown = []
  const routed = [] // taskIds forwarded to focusMainFromNotification
  const stubs = {
    electron: {
      Notification: class {
        constructor (opt) { this.opt = opt }
        on (evt, fn) { if (evt === 'click') clicks.push(fn) }
        show () { shown.push(this.opt) }
      },
      shell: { openExternal: async () => {}, openPath: () => '' },
      dialog: { showMessageBox: async () => ({ response: 1 }) }
    },
    '../scheduler': { notifyTimeoutOptsForApp: () => ({}), focusMainFromNotification: (taskId) => routed.push(taskId) }
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    if (request === 'electron-updater') return { autoUpdater: { on: () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  let h
  try {
    const mod = require_('../../../src/main/handlers/system.js')
    h = mod({ isLocked: () => false, allowWithinRate: () => true, i18n: { mt: k => k }, app: { getPath: () => tmpDir('sys') } })
    const e = { sender: { id: 77 } }
    // payload with taskId → click routes the task
    h.notification(e, { title: 't', body: 'b', taskId: 'task_42' })
    assert.equal(shown.length, 1)
    assert.equal(clicks.length, 1, 'a click handler must be mounted on the renderer-channel notification')
    clicks[0]()
    assert.deepEqual(routed, ['task_42'], 'taskId must be forwarded to the lock-aware focus path')
    // payload without taskId → click still focuses (no task push)
    h.notification(e, { title: 't2' })
    assert.equal(clicks.length, 2)
    clicks[1]()
    assert.deepEqual(routed, ['task_42', undefined], 'no taskId → focus path called with undefined')
  } finally { Module._load = origLoad }
  // NOTE: the patch must stay active through the click — the handler requires '../scheduler'
  // lazily (delayed require inside the click handler).
})

/* ---- Fix 4: float rebuild must not inherit the dead window's handshake ---- */
const Module4 = require_('module')
{
  const stubs4 = {
    electron: {
      app: { getPath: () => process.env.TEMP || os.tmpdir(), isPackaged: false },
      BrowserWindow: class {},
      screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 }, bounds: { x: 0, y: 0, width: 800, height: 600 } }),
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        on () {}, getAllDisplays: () => []
      }
    },
    '../db': { isOpen: () => false, call: () => null }
  }
  const orig = Module4._load
  Module4._load = function (request, parent, isMain) {
    if (stubs4[request]) return stubs4[request]
    return orig.call(this, request, parent, isMain)
  }
  process.on('exit', () => { Module4._load = orig })
}
const tf = require_('../../../src/main/tomato-float.js')

test('W33 F4: after a handshake reset (create/rebuild), no handshake ⇒ healthySince is false', () => {
  const H = tf.HANDSHAKE_TIMEOUT_MS
  const t0 = Date.now()
  tf.__renderHealth.note(t0) // dead window's last handshake
  assert.equal(tf.__renderHealth.healthySince(t0, t0 + 1000), true, 'recency-based health pre-rebuild')
  // destroy + rebuild → create() resets the slate; the new window has NOT handshook yet
  tf.__renderHealth.reset()
  assert.equal(tf.__renderHealth.healthySince(t0 + H * 3, t0 + H * 3 + 1000), false, 'rebuilt window must not be judged healthy on the old handshake')
  // and a fresh handshake restores health
  const t1 = Date.now()
  tf.__renderHealth.note(t1)
  assert.equal(tf.__renderHealth.healthySince(t1 + 1, t1 + 1000), true)
})

/* ---- Fix 5: quick-add null-display fallback keeps the bar on-screen ---- */
const qa = require_('../../../src/main/quick-add.js')

test('W33 F5: boundsForDisplay(null) — all probes failed → positive on-screen coordinates', () => {
  const b = qa.boundsForDisplay(null)
  assert.ok(b.x >= 0, 'x must not be negative (old code produced -240), got ' + b.x)
  assert.ok(b.y >= 0, 'y must not be negative, got ' + b.y)
  assert.equal(b.width, 480)
  assert.equal(b.height, 64)
})

test('W33 F5: boundsForDisplay keeps the correct-display math for a real display object', () => {
  const b = qa.boundsForDisplay({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  assert.equal(b.x, Math.round((1920 - 480) / 2))
  assert.equal(b.y, Math.round(1040 * 0.18))
  const b2 = qa.boundsForDisplay({ bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } })
  assert.equal(b2.x, 1920 + Math.round((1920 - 480) / 2), 'secondary display centering unchanged')
})
