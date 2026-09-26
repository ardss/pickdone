/**
 * R3-stability (2026-09-26): firedReminders LRU eviction must never drop an UNPERSISTED watermark.
 * markFired's all-unwritten fallback (2000-entry burst inside the 60s persist debounce) used to
 * delete the oldest entry with its watermark still unwritten — it re-fired after a restart.
 * Now: flushFiredNow runs BEFORE the eviction; if the flush failed (persist-retry path, detected
 * via the written flags), the eviction is skipped entirely and the map exceeds FIRED_MAX by one
 * entry until the next successful flush.
 * Isolation: TODO_DB_DIR + TODO_USER_DATA_DIR on fresh temp dirs; electron / electron-log stubbed
 * via Module._load; db.js / command-bus.js pre-planted in the require cache (no real DB touched).
 * Run: node --test test/scheduler-fired-watermark.test.js
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-wm-db-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-wm-ud-'))

const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { Notification: function () {} }
  if (request === 'electron-log') return { info () {}, warn () {}, error () {} }
  return origLoad.call(this, request, parent, isMain)
}

const ROOT = path.resolve(__dirname, '..')
const scheduler = require(path.join(ROOT, 'src/main/scheduler.js'))

/** Pre-plant the lazily-required './db.js' and './command-bus' in the require cache so
 *  flushFiredNow commits through a spy instead of the real DB. */
const commits = []
let commitShouldFail = false
function plantFlushTargets () {
  const dbResolved = require.resolve(path.join(ROOT, 'src/main/db.js'))
  require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: { call: () => null } }
  const cbResolved = require.resolve(path.join(ROOT, 'src/main/command-bus.js'))
  require.cache[cbResolved] = {
    id: cbResolved, filename: cbResolved, loaded: true,
    exports: { commit: (table, op, args) => {
      if (commitShouldFail) throw new Error('simulated persist failure')
      commits.push(args)
    } }
  }
}
plantFlushTargets()

const FIRED_MAX = 2000
function fillUnwritten (n, prefix) {
  for (let i = 0; i < n; i++) scheduler._fired.set(prefix + i, { ts: 1000 + i, written: false })
}

test('all-unwritten eviction persists the victim watermark BEFORE deleting it, bound still holds', () => {
  scheduler._clearStateForTest()
  commits.length = 0
  commitShouldFail = false
  fillUnwritten(FIRED_MAX, 'k')
  scheduler._markFired('brand-new')
  // The oldest unwritten entry ('k0') was the eviction victim: its watermark must be ON DISK
  // (present in the packed meta payload passed to command-bus.commit) before the delete.
  assert.equal(commits.length, 1, 'a flush must have run synchronously before the eviction')
  const packed = commits[0][1]
  assert.ok(typeof packed === 'string' && packed.split('\u001f').some(p => p.startsWith('k0|')),
    "the evicted victim's watermark must be in the persisted payload")
  assert.ok(scheduler._fired.has('brand-new'), 'the new watermark is recorded')
  assert.ok(scheduler._fired.size <= FIRED_MAX, 'map stays within the bound after a successful flush, got ' + scheduler._fired.size)
})

test('when the flush fails the eviction is skipped (map exceeds the bound by one, nothing dropped)', () => {
  scheduler._clearStateForTest()
  commits.length = 0
  commitShouldFail = true // persist-retry path: flushFiredNow swallows, written flags stay false
  fillUnwritten(FIRED_MAX, 'j')
  scheduler._markFired('brand-new-2')
  assert.ok(scheduler._fired.has('j0'), "the would-be victim's watermark must NOT be dropped on a failed flush")
  assert.ok(scheduler._fired.has('brand-new-2'), 'the new watermark is still recorded')
  assert.equal(scheduler._fired.size, FIRED_MAX + 1, 'bound may be exceeded by exactly one entry; it self-heals on the next flush')
})

test('behavior preserved: written-first eviction unchanged (oldest WRITTEN entry goes, no flush needed)', () => {
  scheduler._clearStateForTest()
  commits.length = 0
  commitShouldFail = false
  fillUnwritten(FIRED_MAX - 1, 'u') // 1999 unwritten, newest-inserted
  scheduler._fired.set('old-written', { ts: 1, written: true }) // oldest overall, safely persisted
  scheduler._markFired('brand-new-3')
  assert.equal(commits.length, 0, 'no synchronous flush in the normal written-first path')
  assert.ok(!scheduler._fired.has('old-written'), 'the oldest WRITTEN entry is still the victim')
  assert.ok(scheduler._fired.has('u0'), 'unwritten entries are untouched by written-first eviction')
  assert.ok(scheduler._fired.has('brand-new-3'))
  assert.ok(scheduler._fired.size <= FIRED_MAX)
})
