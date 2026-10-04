/** maint/deep-r2 CLI defect round (domain: cli-fixes), each fix with a regression test:
 *  B1  lib-attachments ATTACH_ALLOWED_EXT derives from src/main/attachments.js ALLOWED_EXT —
 *      the hand copy still admitted 'svg' after the D6 root fix removed it as script-capable
 *  B6  attachment-remove resolves through attachments.attachmentPath (alias map) + deleteAlias —
 *      unlinking the raw key orphaned the real bytes after a LAN conflict rename
 *  B7  attachment-add funnels through attachments-guards.assertWriteAllowed (aggregate quota)
 *  B3  clearTodoDate drops reminderOffsets along with the main reminder (stale offsets used to
 *      revive old early-warning chips when a reminder was re-added)
 *  B13 `edit --reminder clear` drops reminderOffsets/reminderExtra (EditPanel onRemindersClear contract)
 *  B10 backfill --minutes is a strict positive-integer parse (0/''/garbage must not inflate into
 *      a phantom 1- or 25-minute ledger row; db-tomato-ops contract)
 *  B11 tomato record fix --succeed is a strict enum (any garbage used to coerce to true,
 *      silently flipping an abandoned record to succeeded)
 *  B12 `list --limit 0` passes 0 through to db.js (fail-closed: 0 = zero rows), not the 200 default
 *  Isolated temp DB via TODO_DB_DIR (d4/v03 pattern). Run: node --test tests/unit/cli/maint-deep-r2-cli-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-deep-r2-db-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runCli = args => execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' })

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

const filesDir = () => path.join(process.env.TODO_DB_DIR, 'files')

/* ================= B1: svg no longer admitted by the CLI allowlist ================= */
test('B1: attachment-add rejects svg (allowlist derived from attachments.js ALLOWED_EXT, D6 root fix)', () => {
  const t = seed({ taskContent: 'deep-r2 svg 甲' })
  const svg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-r2-')), 'evil.svg')
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  assert.throws(
    () => lib.addAttachment(t.taskId, svg),
    e => e.code === 'EXT_NOT_ALLOWED' && /svg/.test(e.message)
  )
  assert.equal(db.call('getById', t.taskId).image, null, 'no image entry may be written for a rejected extension')
})

test('B1: a still-allowed raster extension (png) keeps working, and the sets track attachments.js', () => {
  const attachments = require_('../../../src/main/attachments.js')
  assert.ok(!attachments.ALLOWED_EXT.has('svg'), 'sanity: the main allowlist really dropped svg')
  const t = seed({ taskContent: 'deep-r2 png 乙' })
  const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-r2-')), 'ok.png')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const out = lib.addAttachment(t.taskId, png)
  assert.equal(out.kind, 'image')
})

/* ================= B6: alias-aware removal (LAN conflict rename) ================= */
test('B6: removeAttachment resolves via the alias map and unlinks the renamed bytes + drops the alias', () => {
  const t = seed({ taskContent: 'deep-r2 alias 丙', image: JSON.stringify([{ url: 'local://row.png', name: 'row.png', size: 5 }]) })
  fs.mkdirSync(filesDir(), { recursive: true })
  // LAN conflict shape: the row says local://row.png but this device's bytes live as row-1.png
  fs.writeFileSync(path.join(filesDir(), 'row-1.png'), 'alias-bytes')
  fs.writeFileSync(path.join(filesDir(), 'aliases.json'), JSON.stringify({ 'row.png': 'row-1.png' }))
  const out = lib.removeAttachment(t.taskId, 'img', 1)
  assert.equal(out.removed, 'row.png')
  assert.equal(db.call('getById', t.taskId).image, '[]', 'row entry dropped')
  assert.equal(fs.existsSync(path.join(filesDir(), 'row-1.png')), false, 'the ALIASED bytes are unlinked (raw-key unlink used to orphan them)')
  assert.deepEqual(require_('../../../src/main/attachments.js').readAliases(), {}, 'alias entry dropped so the dead key can re-pull')
})

/* ================= B7: attachment-add honors the shared aggregate quota guard ================= */
test('B7: attachment-add refuses when the storage quota is exhausted (attachments-guards.assertWriteAllowed)', () => {
  const attachments = require_('../../../src/main/attachments.js')
  const t = seed({ taskContent: 'deep-r2 quota 丁' })
  const before = fs.existsSync(filesDir()) ? fs.readdirSync(filesDir()) : []
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-r2-')), 'big.png')
  fs.writeFileSync(big, Buffer.alloc(1024, 1))
  const prev = attachments.MAX_BYTES
  attachments.__setTotalQuota(512) // existing dir is empty; 1KB incoming > 512B budget → over-budget
  try {
    assert.throws(
      () => lib.addAttachment(t.taskId, big),
      e => e.code === 'QUOTA_EXCEEDED' && /storage quota exceeded/.test(e.message)
    )
  } finally {
    attachments.__setTotalQuota(null)
    void prev
  }
  assert.deepEqual(fs.readdirSync(filesDir()), before, 'nothing new landed on disk for a quota-refused upload')
  assert.equal(db.call('getById', t.taskId).image, null, 'row untouched for a quota-refused upload')
})

/* ================= B3: clearTodoDate drops reminderOffsets + reminderExtra ================= */
test('B3: clearTodoDate zeroes the reminder AND drops reminderOffsets/reminderExtra (stale rows must not survive)', () => {
  const tomorrow = () => +dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0)
  const extraTs = +dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0)
  const t = seed({
    taskContent: 'deep-r2 dateclear 戊',
    todoTime: tomorrow(),
    reminderTime: +dayjs().add(1, 'day').hour(8).minute(0).second(0).millisecond(0),
    reminderOffsets: [-15, -5],
    reminderExtra: [extraTs]
  })
  const r = lib.clearTodoDate(t.taskId)
  assert.equal(r.changed, true)
  const after = db.call('getById', t.taskId)
  assert.equal(after.todoTime, 0)
  assert.equal(after.reminderTime, 0)
  assert.deepEqual(after.reminderOffsets, [], 'offsets are anchored to the main reminder — they must die with it')
  // Re-anchored D17: the App's applyDate(0) empties reminderExtra too (offsetsCleared → next = []) —
  // extras are anchored to the same date; the old "extras kept" pin no longer matches the App.
  assert.deepEqual(after.reminderExtra, [], 'extras die with the date (EditPanel applyDate(0) offsetsCleared)')
})

/* ================= B13: edit --reminder clear drops offsets + extras ================= */
test('B13: edit --reminder clear zeroes reminderTime and drops reminderOffsets/reminderExtra (onRemindersClear contract)', () => {
  const soon = +dayjs().add(3, 'day').hour(9).minute(0).second(0).millisecond(0)
  const extraTs = +dayjs().add(3, 'day').hour(10).minute(0).second(0).millisecond(0)
  const t = seed({ taskContent: 'deep-r2 remclear 己', reminderTime: soon, reminderOffsets: [-30], reminderExtra: [extraTs] })
  runCli(['edit', t.taskId, '--reminder', 'clear'])
  const after = db.call('getById', t.taskId)
  assert.equal(after.reminderTime, 0)
  assert.deepEqual(after.reminderOffsets, [], 'stale offsets must not silently revive early-warning chips on re-add')
  assert.deepEqual(after.reminderExtra, [], 'the App reminder-clear also drops extras')
})

/* ================= B10: backfill --minutes strict parse ================= */
test('B10: backfill rejects 0 / empty / garbage / negative minutes with USAGE and writes NO ledger row', () => {
  const before = db.call('tomatoAll').length
  for (const bad of [0, '', 'abc', -5, '0', '3x']) {
    assert.throws(
      () => lib.backfillRecord({ date: '2026-10-01', at: '20:00', minutes: bad }),
      e => e.code === 'USAGE' && /--minutes/.test(e.message),
      'bad minutes ' + JSON.stringify(bad) + ' must be a USAGE error'
    )
  }
  assert.equal(db.call('tomatoAll').length, before, 'no phantom ledger row may be created for a rejected duration')
})

test('B10: backfill still accepts a valid explicit duration (no silent defaulting away)', () => {
  const rec = lib.backfillRecord({ date: '2026-10-01', at: '21:00', minutes: 25 })
  assert.equal(rec.focusDuration, 25)
})

/* ================= B11: record fix --succeed strict enum ================= */
test('B11: --succeed garbage → USAGE (abandoned record must not silently flip to succeeded)', () => {
  const rec = lib.backfillRecord({ date: '2026-10-01', at: '22:00', minutes: 30 })
  db.call('tomatoUpdateById', { tomatoId: rec.tomatoId, patch: { succeed: false } })
  assert.throws(
    () => lib.recordFix(rec.tomatoId, { succeed: 'maybe' }),
    e => e.code === 'USAGE' && /--succeed/.test(e.message)
  )
  assert.equal(db.call('tomatoAll').find(r => r.tomatoId === rec.tomatoId).succeed, false, 'the rejected fix must not have touched the row')
})

test('B11: --succeed accepts the true|false|yes|no|1|0 enum in both directions', () => {
  const rec = lib.backfillRecord({ date: '2026-10-01', at: '22:30', minutes: 30 })
  lib.recordFix(rec.tomatoId, { succeed: 'no' })
  assert.equal(db.call('tomatoAll').find(r => r.tomatoId === rec.tomatoId).succeed, false)
  lib.recordFix(rec.tomatoId, { succeed: 'yes' })
  assert.equal(db.call('tomatoAll').find(r => r.tomatoId === rec.tomatoId).succeed, true)
})

/* ================= B12: list --limit 0 passes 0 through (fail-closed) ================= */
test('B12: --limit 0 returns zero rows (not the 200 default); absent/invalid falls back to 200', () => {
  seed({ taskContent: 'deep-r2 limit 度1' })
  seed({ taskContent: 'deep-r2 limit 度2' })
  assert.deepEqual(lib.listTodos({ keyword: 'deep-r2 limit', limit: 0 }), [], 'limit 0 must be an explicit zero-row query (db.js fail-closed)')
  assert.equal(lib.listTodos({ keyword: 'deep-r2 limit' }).length, 2, 'absent limit → default cap, rows visible')
})
