/**
 * maint/d22 round — GC + durability fixes:
 *  - computeMetaGc: per-task meta families survive while the row is restorable from the recycle
 *    bin (tombstones included in the live set), while repeatRule keys stay live-only;
 *  - windows.js: crash-relaunch marker uses the durable write path (source pin);
 *  - db.js/db-bulk-ops.js: hard delete/purge prunes the scheduler's firedReminders watermark
 *    entries for the deleted taskIds.
 * Run: node --test tests/unit/main/d22-main-gc-durability.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const srcOf = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const { computeMetaGc } = require('../../../src/main/handlers/shared.js')
const db = require('../../../src/main/db.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'd22-main-'))


/* ---------------- fix 6 (P3): recycle-bin rows keep their per-task meta ---------------- */
test('d22: computeMetaGc keeps binned-row task meta but GCs repeatRule keys of binned rows', () => {
  const now = Date.now()
  const todos = [
    { taskId: 'live1', repeatId: 'rid_live', deleted: 0 },
    { taskId: 'binned1', repeatId: 'rid_binned', deleted: 1, deletedAt: now - 86400000 }
  ]
  const keys = [
    'tomatoEstimateState:binned1', // must SURVIVE (restorable row)
    'planChipsSnapshot:binned1', // must SURVIVE
    'snowDedup:binned1:k1', // must SURVIVE
    'tomatoEstimateState:gone1', // dead: no row at all
    'repeatRule:rid_binned', // must DIE (deliberate 2026-09-19 live-only rule, unchanged)
    'repeatRule:rid_live' // must SURVIVE
  ]
  const dead = computeMetaGc(keys, [], todos)
  assert.deepEqual(dead.sort(), ['repeatRule:rid_binned', 'tomatoEstimateState:gone1'].sort())
})

/* ---------------- fix 5 (P3): durable crash-marker write (source pin) ---------------- */
test('d22: windows.js crash-relaunch marker goes through durable-fs writeFileDurable', () => {
  const src = srcOf('src/main/windows.js')
  assert.match(src, /require\('\.\/durable-fs'\)\.writeFileDurable\(crashMarkerPath\(\)/, 'writeCrashRelaunchCount must use the tmp→fsync→rename write path')
  assert.doesNotMatch(src, /fs\.writeFileSync\(crashMarkerPath\(\)/, 'bare writeFileSync must be gone (torn marker reset the crash-loop budget)')
})

/* ---------------- fix 7 (P3): hard delete prunes the fired-reminder watermark ---------------- */
test('d22: hardDelete/hardDeleteMany prune firedReminders entries for the deleted ids', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'fw_t1', taskContent: 'one' })
  db.call('upsert', { taskId: 'fw_t2', taskContent: 'two' })
  const blob = JSON.stringify([['fw_t1:0', 111], ['fw_t1:x5', 222], ['fw_t2:0', 333]])
  db.call('setMeta', ['firedReminders:', blob])
  db.call('hardDelete', 'fw_t1')
  const kept1 = JSON.parse(db.call('getMeta', 'firedReminders:'))
  assert.deepEqual(kept1, [['fw_t2:0', 333]], 'red before the fix: watermark entries outlived their tasks')
  db.call('hardDeleteMany', ['fw_t2'])
  const kept2 = JSON.parse(db.call('getMeta', 'firedReminders:'))
  assert.deepEqual(kept2, [], 'hardDeleteMany prunes too')
})

test('d22: purgeRecycleBin prunes firedReminders entries of purged rows (legacy blob untouched)', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'fw_t3', taskContent: 'binned', delete: 1 })
  db.call('setMeta', ['firedReminders:', JSON.stringify([['fw_t3:0', 42], ['other:0', 7]])])
  const purged = db.call('purgeRecycleBin')
  assert.ok(purged.includes('fw_t3'))
  assert.deepEqual(JSON.parse(db.call('getMeta', 'firedReminders:')), [['other:0', 7]])
  // Legacy packed blob (not JSON): must be left untouched, never mis-parsed.
  db.call('upsert', { taskId: 'fw_t4', taskContent: 'legacy', delete: 1 })
  db.call('setMeta', ['firedReminders:', 'fw_t4:0|12345\x1fother:1|999'])
  db.call('purgeRecycleBin')
  assert.equal(db.call('getMeta', 'firedReminders:'), 'fw_t4:0|12345\x1fother:1|999', 'legacy packed watermark blob is not rewritten')
})
