/**
 * W19 behavior fixes — regression guards.
 * Fixes covered:
 *   [1] rescheduleExpired undo snapshot (utils/core.js): the snapshot used to carry only
 *       {id, dayStart, todoTime} while crossDayMovePatch also re-anchors reminderTime/
 *       reminderExtra onto the new day — undo left reminders stranded on the expired day.
 *       Now the snapshot keeps the full original row (orig) + the forward patch, and the
 *       three list views (Category/Project/Tag) revert via crossDayRevertPatch(orig, patch).
 *   [2] nlDate mixed CJK path (utils/nlDate.js): an ILLEGAL English time word ("明天 45pm")
 *       used to be silently swallowed (Chinese parse ran on the peeled text); it now gives
 *       up wholesale like the pure-English branch — restText keeps the raw input, no date chip.
 * Run: node --test tests/unit/renderer/w19-reschedule-undo-nldate-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import dayjs from 'dayjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [1] rescheduleExpired snapshot + view reverts ---------- */

test('[1a] rescheduleExpired snap keeps the full original row and the forward patch', async () => {
  const core = await importMod('renderer/js/utils/core.js')
  const { crossDayMovePatch, crossDayRevertPatch } = await importMod('renderer/js/utils/crossDayMove.js')

  const today = +dayjs().startOf('day')
  const oldDay = today - 3 * 86400000
  const afternoonAt = d => d + 14 * 3600000 + 30 * 60000 // 14:30 on that day
  const row = {
    taskId: 't1',
    complete: false,
    dayStart: oldDay,
    todoTime: afternoonAt(oldDay),
    reminderTime: afternoonAt(oldDay) + 3600000, // 15:30 on the expired day
    reminderExtra: [afternoonAt(oldDay) + 7200000]
  }
  const rows = [row]
  const dispatch = async (action, payload) => {
    if (action !== 'todo/updateTodoFields') return // todo/computeViews: view rebuild, no-op here
    const { taskId, patch } = payload
    const fields = { ...patch }
    delete fields._deferViews // the real action consumes _deferViews, never persists it
    Object.assign(rows.find(r => r.taskId === taskId), fields)
  }

  const { n, snap } = await core.rescheduleExpired(dispatch, [row], today)
  assert.equal(n, 1)
  const s = snap[0]
  // legacy fields still present (backward compat with any consumer of id/dayStart/todoTime)
  assert.equal(s.id, 't1')
  assert.equal(s.dayStart, oldDay)
  assert.equal(s.todoTime, afternoonAt(oldDay))
  // full original row + forward patch now carried for exact revert
  assert.deepEqual(s.orig, { taskId: 't1', complete: false, dayStart: oldDay, todoTime: afternoonAt(oldDay), reminderTime: afternoonAt(oldDay) + 3600000, reminderExtra: [afternoonAt(oldDay) + 7200000] })
  assert.equal(s.patch.dayStart, today)
  // forward patch really re-anchors the reminder onto the new day (the premise of the bug)
  assert.equal(s.patch.reminderTime, today + 15 * 3600000 + 30 * 60000)
  // revert built from (orig, patch) restores EXACTLY what the move rewrote
  const revert = crossDayRevertPatch(s.orig, s.patch)
  assert.deepEqual(revert, { dayStart: oldDay, todoTime: afternoonAt(oldDay), reminderTime: afternoonAt(oldDay) + 3600000, reminderExtra: [afternoonAt(oldDay) + 7200000] })
  Object.assign(rows[0], revert)
  assert.deepEqual(rows[0], s.orig, 'undo restores the row to its pre-move state, reminders back on the expired day')
  // sanity: the helper itself still behaves as before
  assert.ok('todoTime' in crossDayMovePatch({ dayStart: oldDay, todoTime: oldDay + 1 }, today, ts => ts))
})

test('[1b] Category/Project/Tag views revert via crossDayRevertPatch(orig, patch), not the two-field guess', () => {
  for (const f of ['renderer/js/views/CategoryView.vue', 'renderer/js/views/ProjectView.vue', 'renderer/js/views/TagView.vue']) {
    const src = read(f)
    assert.ok(src.includes("from '../utils/crossDayMove.js'"), f + ' imports crossDayRevertPatch')
    assert.ok(src.includes('crossDayRevertPatch(r.orig, r.patch)'), f + ' revertOf uses crossDayRevertPatch(r.orig, r.patch)')
    assert.ok(!src.includes('patch: { dayStart: r.dayStart, todoTime: r.todoTime }'), f + ' no longer uses the blind two-field revert patch')
  }
})

/* ---------- [2] nlDate mixed path: illegal time word is not silently swallowed ---------- */

test('[2a] mixed input with an illegal time word gives up wholesale — restText keeps the raw text, no chip', async () => {
  const { parseNaturalDate } = await importMod('renderer/js/utils/nlDate.js')
  const base = dayjs('2026-10-30 10:00')

  // The Chinese core run on the RAW text keeps the bogus word in restText (it may still land
  // the bare date chip "明天"/"今天" — the point is the time word is no longer erased).
  const cases = [['明天 45pm 买菜', '45pm'], ['今天 99:00 开会', '99:00']]
  for (const [text, word] of cases) {
    const r = parseNaturalDate(text, base)
    assert.ok(r.restText.includes(word), text + ': illegal time word stays visible in restText')
    assert.ok(!/\d{1,2}:\d{2}/.test(r.label), text + ': label never carries an illegal time')
  }
})

test('[2b] mixed input with a legal time word still peels and applies it', async () => {
  const { parseNaturalDate } = await importMod('renderer/js/utils/nlDate.js')
  const base = dayjs('2026-10-30 10:00')
  const r = parseNaturalDate('明天3pm 买菜', base)
  assert.ok(r.date, 'date parsed')
  assert.equal(r.date.year(), 2026)
  assert.equal(r.date.month(), 9) // Oct (0-based)
  assert.equal(r.date.date(), 31) // tomorrow
  assert.equal(r.date.hour(), 15)
  assert.equal(r.date.minute(), 0)
  assert.equal(r.label, '明天 15:00')
  assert.equal(r.restText, '买菜', 'peeled time word removed from restText')
})
