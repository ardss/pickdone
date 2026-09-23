/**
 * maint/d7 round — renderer utils fixes:
 *  - milestones.parseMilestoneDate: bare 'M-D' input must resolve to the CURRENT year
 *    (V8's fallback Date parse turns '9-22' into 2001-09-22 and calls it valid, which used
 *    to short-circuit the year-completion branch);
 *  - repeat.expandRepeatDates: duplicate entries in repeatWeekDays/repeatMonthDays must not
 *    produce duplicate instances on the same day;
 *  - nlDate.parseNaturalDate: an out-of-range time (3:99pm) gives up wholesale — no date
 *    chip while the raw text stays in the body;
 *  - editSave.createSaveQueue: the debounce callback aligns with flushSave — the queued
 *    patch commits to its enqueue-time task even when the current taskId is null, and dirty
 *    fields drained after a task switch go to the CURRENT task, never merged onto the old one;
 *  - dbMirror + onboardingTours fixes locked in as structural source assertions
 *    (aux-window gate via isAuxWindow(); stale-success no longer clears the new blob's retry
 *    budget; journey seed dedup + capped polls with a safe exit).
 * Run: node --test tests/unit/utils/d7-utils-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const { dayjs } = await import('../../../renderer/js/utils/core.js')

test('milestones: bare M-D input resolves to the current year, not V8\'s 2001 fallback', async () => {
  const { parseMilestoneDate } = await import('../../../renderer/js/utils/milestones.js')
  const y = dayjs().year()
  const expected = +dayjs(`${y}-09-22`).startOf('day')
  assert.equal(parseMilestoneDate('9-22'), expected, '9-22 lands on this year Sep 22')
  assert.equal(parseMilestoneDate('09-22'), expected, 'zero-padded M-D too')
  // Full dates, keywords and relative offsets keep working
  assert.equal(parseMilestoneDate(`${y}-01-15`), +dayjs(`${y}-01-15`).startOf('day'))
  assert.equal(parseMilestoneDate('today'), +dayjs().startOf('day'))
  assert.equal(parseMilestoneDate('+3d'), +dayjs().add(3, 'day').startOf('day'))
  assert.equal(parseMilestoneDate('not a date'), null)
})

test('repeat: duplicate weekday/monthday entries in dirty settings produce no duplicate instances', async () => {
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  const base = +dayjs('2026-01-05T08:00') // a Monday
  // Week: [1,1,3] over 2 weeks -> 4 instances, all distinct days
  const week = expandRepeatDates(base, { repeatType: 'week', repeatWeekDays: [1, 1, 3], repeatWeekCount: 2 })
  const weekDays = week.map(d => d.format('YYYY-MM-DD'))
  assert.equal(week.length, 4, 'no duplicate instances from the repeated weekday 1')
  assert.equal(new Set(weekDays).size, weekDays.length, 'all week instances are distinct days')
  // Month: [1,1,15] over 2 months; Jan 1 is before the base date and gets skipped -> 3 instances
  const month = expandRepeatDates(base, { repeatType: 'month', repeatMonthDays: [1, 1, 15], repeatMonthCount: 2 })
  const monthDays = month.map(d => d.format('YYYY-MM-DD'))
  assert.equal(month.length, 3, 'no duplicate instances from the repeated monthday 1')
  assert.equal(new Set(monthDays).size, monthDays.length, 'all month instances are distinct days')
})

test('nlDate: out-of-range time gives up wholesale — no chip while the raw text stays in the body', async () => {
  const { parseNaturalDate } = await import('../../../renderer/js/utils/nlDate.js')
  const r = parseNaturalDate('tomorrow 3:99pm', dayjs('2026-03-10T10:00'))
  assert.equal(r.date, null, 'invalid time -> no date at all (QuickAdd renders no chip)')
  assert.equal(r.label, '')
  assert.equal(r.restText, 'tomorrow 3:99pm', 'body keeps the full raw text')
  // A valid time still parses
  const ok = parseNaturalDate('tomorrow 3pm', dayjs('2026-03-10T10:00'))
  assert.ok(ok.date, 'valid time still yields a date')
})

test('editSave: debounce callback commits the queued patch to its enqueue-time task; switched dirty fields go to the current task', async () => {
  const { createSaveQueue } = await import('../../../renderer/js/utils/editSave.js')
  const calls = []
  const store = { async dispatch (type, payload) { calls.push(payload) } }
  let current = 'a'
  const q = createSaveQueue(store, {
    getTaskId: () => current,
    debounceMs: 5,
    dirtyPatchFor: k => ({ subtasks: { subtasks: '["x"]' } }[k])
  })
  q.boot()
  q.queueSave({ title: 'A' }) // enqueued while task 'a' is open
  current = 'b' // task switched inside the debounce window
  q.markDirty('subtasks')
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(calls, [
    { taskId: 'a', patch: { title: 'A' } }, // queued patch -> its enqueue-time task only
    { taskId: 'b', patch: { subtasks: '["x"]' } } // dirty fields -> the CURRENT task
  ], 'no cross-task contamination, queued patch never dropped')
})

test('editSave: queued patch survives the current taskId going null mid-debounce', async () => {
  const { createSaveQueue } = await import('../../../renderer/js/utils/editSave.js')
  const calls = []
  const store = { async dispatch (type, payload) { calls.push(payload) } }
  let current = 'a'
  const q = createSaveQueue(store, { getTaskId: () => current, debounceMs: 5, dirtyPatchFor: () => ({}) })
  q.boot()
  q.queueSave({ title: 'A' })
  current = null // panel closed before the debounce fired
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(calls, [{ taskId: 'a', patch: { title: 'A' } }], 'queued patch still commits to its enqueue-time task')
})

test('dbMirror: aux-window gate uses the shared isAuxWindow() helper; stale success keeps the newer blob retry budget', () => {
  const src = read('renderer/js/utils/dbMirror.js')
  assert.ok(src.includes('import { isAuxWindow } from "./auxWindow.js"'), 'isAuxWindow imported')
  assert.ok(!/window\.location\.hash && \/__tomato-float/.test(src), 'hand-copied hash regex removed')
  assert.ok(/\.then\(\(\) => \{ if \(newest\[metaKey\] === blob\) delete attempts\[metaKey\] \}\)/.test(src),
    'success only resets attempts when THIS blob is still the newest for the key')
})

test('onboardingTours: journey seed is deduped by sample-task text and polls are capped with a safe exit', () => {
  const src = read('renderer/js/utils/onboardingTours.js')
  assert.ok(/const seedTaskExists = \(\) => \[\.\.\.document\.querySelectorAll\('\.td-item'\)\]\.some\(el => \(el\.textContent \|\| ''\)\.includes\(J_SEED_TEXT\(\)\)\)/.test(src),
    'seed dedup checks the rendered sample-task text')
  assert.ok(/const seedOnce = \(\) => \{\s*\n\s*if \(seedTaskExists\(\)\) return/.test(src),
    'seedOnce is a no-op when the sample task already exists')
  // poll supports a max-duration budget with a timeout exit
  assert.ok(/const poll = \(test, cb, interval = 400, maxMs = 0, onTimeout = null\) => \{/.test(src),
    'poll takes a maxMs budget and an onTimeout exit')
  assert.ok(/Date\.now\(\) - started >= maxMs[\s\S]*?clearInterval\(iv\); if \(onTimeout\) onTimeout\(\)/.test(src),
    'poll self-terminates after the budget and calls onTimeout')
  // every journey watch rides the capped wrapper whose timeout exits through finishAll
  assert.ok(!/watch = poll\(/.test(src), 'no uncapped journey watch polls remain')
  assert.ok(/const pollCapped = \(test, cb\) => poll\(test, cb, 300, JOURNEY_POLL_CAP_MS, \(\) => finishAll\(\)\)/.test(src),
    'capped polls exit through finishAll (driver + banner torn down)')
})
