/** D17 DOM2 CLI/App parity round — regression tests. Fixes covered:
 *  F1  clearTodoDate empties reminderExtra along with reminderOffsets (EditPanel applyDate(0)
 *      offsetsCleared contract — B13: both arrays die with the main reminder)
 *  F2  restoreTodo demotes a dangling repeatId to non-repeating when `repeatRule:<rid>` meta was
 *      GCed (renderer parity: store/todo.js restoreFromRecycle B5 guard + console warning)
 *  F3  single `done` on an already-complete task skips (completedAt untouched, no audit entry,
 *      skipped:true — batch parity with lib-tags batchRun)
 *  F4  `subtask check` toggles the PARENT in sync via shared/subs-core.mjs subsCompleteTarget
 *      (last unchecked sub completes the parent; unchecking un-completes it — App parity)
 *  F5  `add --priority 3` no longer derives important=1 (App addTodo parity: coupling is EDIT-only)
 *  F6  `add` stores difficulty 0 (not null) by default (App addTodo parity)
 *  F7  `edit --dry-run` mirrors the priority⇔important coupling (preview equals the write)
 *  F9  `tomato backfill --minutes 0` is a USAGE error (no silent →25 inflation)
 *  F10 `tomato record fix --minutes 0|garbage` is a USAGE error (no silent floor to 1)
 *  F11 `tomato backfill` default anchor is NOW (App one-click backfill parity), not 20:00
 *  F12 `edit --date <explicit time>` migrates existing chips but never MINTS one (chips are
 *      creation-time only in the App)
 *  Isolated temp DB via TODO_DB_DIR (d4/v03 pattern).
 *  Run: node --test tests/unit/cli/d17-dom2-cli-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-d17-dom2-db-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Flake fix (2026-10-09, C4): every child spawn carries a hard 60s SIGKILL ceiling so a
// stalled CLI becomes a NAMED timeout failure inside run-all's 300s budget instead of an
// unnamed kill at the runner ceiling (which burned the whole budget with zero diagnostics).
const SPAWN_CAPS = { timeout: 60000, killSignal: 'SIGKILL' }
const runCli = args => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8', ...SPAWN_CAPS }))
const runCliRaw = args => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8', ...SPAWN_CAPS })

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
const chipsOf = taskId => db.call('planAll', []).filter(r => r.taskId === taskId)
const auditCount = () => (lib.readAuditLog ? lib.readAuditLog(10000) : []).length

/* ================= F1: date clear empties reminderExtra too ================= */
test('F1: clearTodoDate empties reminderOffsets AND reminderExtra (B13 offsetsCleared contract)', () => {
  const t = seed({
    taskContent: 'd17清除甲',
    todoTime: +dayjs().add(1, 'day').hour(9).minute(0),
    reminderTime: +dayjs().add(1, 'day').hour(8).minute(0),
    reminderOffsets: [-15],
    reminderExtra: [+dayjs().add(2, 'day').hour(10).minute(0)]
  })
  const r = lib.clearTodoDate(t.taskId)
  assert.equal(r.changed, true)
  const after = db.call('getById', t.taskId)
  assert.deepEqual(after.reminderOffsets, [], 'offsets die with the main reminder')
  assert.deepEqual(after.reminderExtra, [], 'extras die with the date too (EditPanel applyDate(0))')
})

/* ================= F2: restore demotes a GCed repeatId ================= */
test('F2: restoreTodo demotes a dangling repeatId (rule meta GCed) to non-repeating, with the App\'s warning', () => {
  const t = seed({ taskContent: 'd17restore乙', delete: true, deletedAt: Date.now(), repeatId: 'rp_d17_gone' })
  const errs = []
  const orig = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  let restored
  try { restored = lib.restoreTodo(t.taskId) } finally { console.error = orig }
  const after = db.call('getById', t.taskId)
  assert.equal(after.delete, false, 'row restored')
  assert.equal(after.repeatId, null, 'dangling repeatId demoted to non-repeating')
  assert.ok(errs.some(s => /dangling repeatId/.test(s) && String(s).includes(t.taskId)), 'console warning mirrors the renderer semantics')
  // sanity: an intact rule keeps the repeatId
  db.call('setMeta', ['repeatRule:rp_d17_alive', JSON.stringify({ freq: 'daily' })])
  const t2 = seed({ taskContent: 'd17restore丙', delete: true, deletedAt: Date.now(), repeatId: 'rp_d17_alive' })
  lib.restoreTodo(t2.taskId)
  assert.equal(db.call('getById', t2.taskId).repeatId, 'rp_d17_alive', 'live rule keeps the repeatId')
  assert.ok(restored)
})

/* ================= F3: already-complete skip on single done ================= */
test('F3: `done` on an already-complete task skips (completedAt untouched, no audit entry)', () => {
  const t = seed({ taskContent: 'd17done丁', complete: true, completedAt: 1234567890 })
  const before = auditCount()
  const r = lib.toggleComplete(t.taskId, true)
  assert.equal(r.skipped, true, 'skip flag surfaced')
  assert.equal(r.renewed, null)
  const after = db.call('getById', t.taskId)
  assert.equal(after.completedAt, 1234567890, 'completedAt NOT rewritten')
  assert.equal(auditCount(), before, 'no audit entry minted')
  // end-to-end through the entry layer: exit 0, no crash
  const raw = runCliRaw(['done', t.taskId])
  assert.equal(raw.status, 0)
  assert.match(raw.stdout, /already complete/)
})

/* ================= F4: subtask check toggles the parent ================= */
test('F4: checking the last unchecked sub completes the parent; unchecking un-completes it (subsCompleteTarget)', () => {
  const subs = JSON.stringify([{ text: 'a', checked: true }, { text: 'b', checked: false }])
  const t = seed({ taskContent: 'd17subs戊', subtasks: subs })
  const r1 = lib.checkSubtask(t.taskId, 'b')
  const after1 = db.call('getById', t.taskId)
  assert.equal(after1.complete, true, 'parent completed in sync')
  assert.ok(after1.completedAt > 0, 'completedAt written like toggleComplete')
  assert.equal(JSON.parse(after1.subtasks).every(s => s.checked), true)
  const r2 = lib.checkSubtask(t.taskId, 'a', false)
  const after2 = db.call('getById', t.taskId)
  assert.equal(after2.complete, false, 'parent un-completed in sync')
  assert.equal(after2.completedAt, 0, 'completedAt zeroed like undo')
  assert.ok(r1 && r2)
})

test('F4b: a parent without subtasks / with partial subs is NOT toggled by unrelated subtask ops', () => {
  const t = seed({ taskContent: 'd17subs己', subtasks: JSON.stringify([{ text: 'x', checked: false }, { text: 'y', checked: false }]) })
  lib.checkSubtask(t.taskId, 'x')
  const after = db.call('getById', t.taskId)
  assert.equal(after.complete, false, 'partial state → parent untouched')
  const bare = seed({ taskContent: 'd17subs庚' })
  lib.addSubtask(bare.taskId, 'only')
  lib.checkSubtask(bare.taskId, '1')
  const afterBare = db.call('getById', bare.taskId)
  assert.equal(afterBare.complete, true, 'single sub checked → parent completes (all done)')
})

/* ================= F5/F6: add defaults match the App addTodo ================= */
test('F5: add --priority 3 does NOT derive important (coupling is EDIT-only) and F6: difficulty defaults to 0', () => {
  const out = runCli(['add', 'd17添加辛', '--priority', '3', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.priority, 3)
  assert.equal(out.data.important, 0, 'no important derivation at create time')
  assert.equal(out.data.difficulty, 0, 'difficulty default 0 like the App addTodo')
})

/* ================= F7: dry-run mirrors the priority⇔important coupling ================= */
test('F7: edit --dry-run shows the coupled important/priority exactly as the real write would', () => {
  const t = seed({ taskContent: 'd17dry壬' })
  const out = runCli(['edit', t.taskId, '--priority', '3', '--dry-run', '--json'])
  assert.equal(out.data.dryRun, true)
  assert.equal(out.data.patch.priority, 3)
  assert.equal(out.data.patch.important, 1, 'priority 3 ⇒ important 1 in the PREVIEW too')
  const out2 = runCli(['edit', t.taskId, '--important', '1', '--dry-run', '--json'])
  assert.equal(out2.data.patch.priority, 3, 'important 1 ⇒ priority 3 in the PREVIEW too')
})

/* ================= F9/F10: strict minutes parses ================= */
test('F9: tomato backfill --minutes 0 (or garbage) is a USAGE error, not a silent 25', () => {
  for (const bad of ['0', 'abc', '-5']) {
    const raw = runCliRaw(['tomato', 'backfill', '--free', '--minutes', bad])
    assert.notEqual(raw.status, 0, 'minutes=' + bad + ' must fail')
    assert.match(String(raw.stderr) + raw.stdout, /positive integer/, 'USAGE message for minutes=' + bad)
  }
  const after = (lib.tomatoRecords() || []).filter(r => r.manual)
  assert.equal(after.length, 0, 'no phantom row written')
})

test('F10: tomato record fix --minutes 0|garbage is a USAGE error (no silent floor to 1)', () => {
  const rec = lib.backfillRecord({ taskId: null, content: 'd17fix', date: dayjs().format('YYYY-MM-DD'), at: '10:00', minutes: 30 })
  assert.throws(() => lib.recordFix(rec.tomatoId, { minutes: 0 }), e => e.code === 'USAGE')
  assert.throws(() => lib.recordFix(rec.tomatoId, { minutes: 'abc' }), e => e.code === 'USAGE')
  lib.recordFix(rec.tomatoId, { minutes: '45' })
  assert.equal(lib.resolveRecord(rec.tomatoId).focusDuration, 45, 'valid fix still works')
})

/* ================= F11: backfill default anchor = now ================= */
test('F11: tomato backfill without --at anchors endTime to NOW (not 20:00)', () => {
  const before = Date.now()
  const raw = runCliRaw(['tomato', 'backfill', '--free', '--minutes', '5'])
  assert.equal(raw.status, 0)
  const recs = (lib.tomatoRecords() || []).filter(r => r.manual && r.focusDuration === 5)
  const rec = recs[recs.length - 1]
  // endTime anchors to "now" (seconds truncated by HH:mm); the block covers the preceding `minutes`
  assert.ok(rec.endTime > before - 90000 && rec.endTime <= Date.now() + 1000, 'endTime anchors to now, got ' + dayjs(rec.endTime).format('HH:mm'))
  assert.ok(Math.abs((rec.endTime - 5 * 60000) - (before - 5 * 60000)) < 120000, 'block is placed just before now, not at 20:00')
})

/* ================= F12: edit --date never mints a chip, still migrates existing ones ================= */
test('F12: edit --date <explicit time> does NOT fabricate a plan chip; an existing chip still follows the day', () => {
  const a = seed({ taskContent: 'd17chip甲' })
  runCli(['edit', a.taskId, '--date', 'tomorrow 10:00', '--json'])
  assert.equal(chipsOf(a.taskId).length, 0, 'no chip minted on edit (creation-time only)')
  // existing chip migrates to the new day, times unchanged
  const b = seed({ taskContent: 'd17chip乙', todoTime: +dayjs().add(1, 'day').hour(9).minute(0) })
  const day1 = dayjs(+dayjs().add(1, 'day').startOf('day')).format('YYYY-MM-DD')
  const day2 = dayjs(+dayjs().add(2, 'day').startOf('day')).format('YYYY-MM-DD')
  db.call('planAddMany', [{ taskId: b.taskId, day: day1, mm: '10:30' }])
  runCli(['edit', b.taskId, '--date', day2 + ' 11:00', '--json'])
  const chips = chipsOf(b.taskId)
  assert.equal(chips.length, 1, 'chip moved, not duplicated')
  assert.equal(chips[0].day, day2, 'chip follows the new day')
  assert.equal(chips[0].mm, '10:30', 'chip keeps its time (no re-mint from the new explicit time)')
})
