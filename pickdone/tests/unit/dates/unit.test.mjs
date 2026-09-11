/**
 * Pure-function unit tests — covers the four pure-logic modules most recently changed and at highest regression risk:
 *   nlDate (natural-language dates) / buckets (three-view bucketing) / repeat (repeat expansion) / search (pinyin fuzzy search) / core (utilities)
 * Run: npm test (node --test, zero third-party test dependencies)
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseNaturalDate } from '../../../renderer/js/utils/nlDate.js'
import { calTitle, buildCompletedBuckets } from '../../../renderer/js/utils/buckets.js'
import { expandRepeatDates, isWeekend } from '../../../renderer/js/utils/repeat.js'
import { matchText, matchTodo, extractTags, escapeHtml, highlightHTML } from '../../../renderer/js/utils/search.js'
import { versionCodeOf, nextSort, parseSubtasks, isImageName, firstImageOfList, formatDayLabel } from '../../../renderer/js/utils/core.js'

/* ---------- cli/audit (AI write operations are traceable) ---------- */
import { createRequire as _cr } from 'module'
import os from 'node:os'
const require_ = _cr(import.meta.url)
process.env.TODO_DB_DIR = require_('fs').mkdtempSync(require_('path').join(os.tmpdir(), 'todo-audit-'))
const audit = require_('../../../cli/audit.js')

test('audit: write ops append to the journal; before/after snapshots are replayable', () => {
  audit.setContext(['done', '写周报'])
  const before = { taskId: 't1', taskContent: '写周报', complete: false, todoTime: 1756344000000, image: 'images/xx.png' }
  const after = { taskId: 't1', taskContent: '写周报', complete: true, completedAt: 1756400000000, todoTime: 1756344000000 }
  audit.record({ action: 'done', targets: [before], changes: [{ before, after }] })
  const entries = audit.readEntries({ n: 10 })
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.equal(e.actor, 'cli')
  assert.equal(e.action, 'done')
  assert.deepEqual(e.argv, ['done', '写周报'])
  assert.equal(e.targets[0].content, '写周报')
  assert.equal(e.changes[0].before.complete, false)
  assert.equal(e.changes[0].after.complete, true)
  // Large fields (attachment image) are excluded from snapshots
  assert.equal(e.changes[0].before.image, undefined)
})

test('audit: action filtering and empty store', () => {
  assert.deepEqual(audit.readEntries({ action: 'purge' }), [])
  audit.record({ action: 'purge', changes: [{ before: { taskId: 't2', taskContent: '旧草稿' } }], note: '彻底删除 1 条（不可恢复）' })
  const purges = audit.readEntries({ action: 'purge' })
  assert.equal(purges.length, 1)
  assert.equal(purges[0].changes[0].after, null)
  assert.match(purges[0].note, /不可恢复/)
})

const DAY = 86400000
const BASE = new Date('2026-08-28T10:20:00').getTime() // Friday

import { dayjs } from '../../../renderer/js/utils/core.js'
const dj = t => dayjs(t)

/* ---------- nlDate ---------- */
test('nlDate: today/tomorrow/day-after/day-after-tomorrow', () => {
  const base = dj(new Date(2026, 7, 28, 10, 20))
  assert.equal(+parseNaturalDate('今天', base).date, +new Date(2026, 7, 28))
  assert.equal(+parseNaturalDate('明天', base).date, +new Date(2026, 7, 29))
  assert.equal(+parseNaturalDate('后天', base).date, +new Date(2026, 7, 30))
  assert.equal(+parseNaturalDate('大后天', base).date, +new Date(2026, 7, 31))
})

test('nlDate: N days later (Arabic and Chinese numerals)', () => {
  const base = dj(new Date(2026, 7, 28, 10, 20))
  assert.equal(+parseNaturalDate('3天后', base).date, +new Date(2026, 7, 31))
  assert.equal(+parseNaturalDate('十天以后', base).date, +new Date(2026, 8, 7))
  // Remaining text must come back in restText
  const r = parseNaturalDate('3天后交房租', base)
  assert.equal(r.restText, '交房租')
})

test('nlDate: full dates', () => {
  const base = dj(new Date(2026, 7, 28))
  assert.equal(+parseNaturalDate('2026-09-01', base).date, +new Date(2026, 8, 1))
  assert.equal(+parseNaturalDate('2026年9月1日', base).date, +new Date(2026, 8, 1))
})

test('nlDate: regression - this-Monday said on Sunday means this weeks past Monday (isoWeek semantics)', () => {
  // 2026-08-30 is a Sunday; this Monday = Aug 24, not +7 into next weeks Aug 31
  const sunday = dj(new Date(2026, 7, 30, 10, 0))
  assert.equal(+parseNaturalDate('本周一', sunday).date, +new Date(2026, 7, 24))
  assert.equal(+parseNaturalDate('下周一', sunday).date, +new Date(2026, 7, 31))
  // Regular case: this-Friday said on Wednesday = the day after tomorrow
  const wed = dj(new Date(2026, 7, 26, 10, 0))
  assert.equal(+parseNaturalDate('本周五', wed).date, +new Date(2026, 7, 28))
})

test('nlDate: regression - noon N means N+12 hours (not forced to 12:00)', () => {
  const base = dj(new Date(2026, 7, 30, 10, 0))
  const r = parseNaturalDate('中午1点', base)
  assert.equal(r.date.hour(), 13, 'noon 1 = 13:00')
  const r12 = parseNaturalDate('中午12点半', base)
  assert.equal(r12.date.hour(), 12)
  assert.equal(r12.date.minute(), 30)
})

test('repeat: regression - yearly repeats never silently carry nonexistent dates like Feb 30', () => {
  const base = +dj(new Date(2026, 1, 10, 9, 0))
  const out = expandRepeatDates(base, { repeatType: '年', repeatYearType: '公历', repeatYearMonth: 2, repeatYearMonthDay: 30, repeatYearCount: 1, repeatInterval: 1 }, [])
  assert.equal(out.length, 0, 'Feb 30 does not exist -> no carried instance generated')
  const ok = expandRepeatDates(base, { repeatType: '年', repeatYearType: '公历', repeatYearMonth: 2, repeatYearMonthDay: 28, repeatYearCount: 1, repeatInterval: 1 }, [])
  assert.equal(ok.length, 1)
  assert.equal(ok[0].format('YYYY-MM-DD'), '2026-02-28') // nearest Feb 28 after base 2026-02-10
})

/* ---------- buckets ---------- */
const T = (dayStart, extra = {}) => ({
  taskId: 't' + dayStart + Math.random(),
  dayStart,
  complete: false,
  delete: false,
  taskSort: 0,
  createTime: 0,
  ...extra
})

test('buckets: calTitle semantics (today/tomorrow/day-after/short date/cross-year) - shim wired to chunk lexicon, asserts the translated copy', () => {
  const now = BASE
  // calTitle returns copy already resolved by tt(); calToday='今天 {w}' (w = weekday)
  assert.ok(calTitle(now, now).startsWith('今天'), 'got ' + calTitle(now, now))
  assert.ok(calTitle(now + DAY, now).startsWith('明天'), 'got ' + calTitle(now + DAY, now))
  assert.ok(calTitle(now + 2 * DAY, now).startsWith('后天'), 'got ' + calTitle(now + 2 * DAY, now))
  // 10 days later in the same year: 'M月D日 周X'
  assert.ok(/^\d+月\d+日/.test(calTitle(now + 10 * DAY, now)), 'got ' + calTitle(now + 10 * DAY, now))
  // Cross-year (200 days later lands in the next year) uses the full format with year
  assert.ok(/^\d{4}年/.test(calTitle(now + 200 * DAY, now)), 'got ' + calTitle(now + 200 * DAY, now))
})

test('buckets: buildCompletedBuckets groups by completion time and hides beyond 30 days', () => {
  const today = BASE
  const list = [
    T(today, { complete: true, completedAt: today - 3600e3 }),
    T(today, { complete: true, completedAt: today - DAY }),
    T(today, { complete: true, completedAt: today - 5 * DAY }),
    T(today, { complete: true, completedAt: today - 20 * DAY }),
    T(today, { complete: true, completedAt: today - 40 * DAY }) // beyond 30 days, must be dropped
  ]
  const g = buildCompletedBuckets(list, today)
  const total = g.reduce((s, b) => s + b.todos.length, 0)
  assert.equal(total, 4)
  assert.equal(g[0].key, 'done-today')
  assert.equal(g[1].key, 'done-yesterday')
  assert.equal(g[2].key, 'done-d7')
  assert.equal(g[3].key, 'done-d30')
})

/* ---------- repeat ---------- */
test('repeat: daily repeat for N days, including the first day', () => {
  const out = expandRepeatDates(BASE, { repeatType: '天', repeatInterval: 1, repeatDayCount: 7 })
  assert.equal(out.length, 7)
  assert.equal(+out[0].startOf('day'), +new Date(2026, 7, 28))
  assert.equal(+out[6].startOf('day'), +new Date(2026, 8, 3))
})

test('repeat: weekly Mon/Fri, skipping dates before the existing anchor', () => {
  // 2026-08-28 is a Friday; weekly Mon/Wed -> this weeks Mon/Wed already passed, start from next week
  const out = expandRepeatDates(BASE, { repeatType: '周', repeatInterval: 1, repeatWeekCount: 2, repeatWeekDays: [1, 3] })
  const days = out.map(d => d.isoWeekday())
  assert.ok(days.every(d => d === 1 || d === 3))
  assert.ok(out[0].valueOf() > BASE)
})

test('repeat: skipWeekends takes effect', () => {
  const out = expandRepeatDates(BASE, { repeatType: '天', repeatInterval: 1, repeatDayCount: 14, skipWeekends: true })
  assert.ok(out.every(d => !isWeekend(d)))
})

/* ---------- search ---------- */
test('search: Chinese substring / full pinyin', () => {
  assert.equal(matchText('整理笔记和内容', '笔记'), true)
  assert.equal(matchText('整理笔记和内容', 'zhengli'), true)  // 整理 = zhengli (full-pinyin substring)
  assert.equal(matchText('整理笔记和内容', 'biji'), true)     // 笔记 = biji
})

test('search: fuzzy match threshold', () => {
  assert.equal(matchText('meeting notes', 'meeting nota'), true)  // edit distance 1
  assert.equal(matchText('abc', 'xyz'), false)
})

test('search: matchTodo covers title/description/subtasks', () => {
  const todo = { taskContent: '主标题', taskDescribe: '说明文字', subtasks: JSON.stringify([{ text: '子任务内容', checked: false }]) }
  assert.equal(matchTodo(todo, '子任务'), true)
  assert.equal(matchTodo(todo, '说明'), true)
  assert.equal(matchTodo(todo, '不存在'), false)
  assert.equal(matchTodo(todo, ''), true) // empty query = match all
})

test('search: extractTags / escapeHtml / highlightHTML', () => {
  assert.deepEqual([...extractTags('做 #测试 和 #重要 的事'), ...extractTags('#复刻')].sort(), ['重要', '复刻', '测试'].sort())
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;')
  assert.equal(highlightHTML('整理笔记', '笔记'), '整理<span class="search-highlight">笔记</span>')
})

/* ---------- core ---------- */
test('core: versionCodeOf / nextSort', () => {
  assert.equal(versionCodeOf('3.14.0'), 31400)
  assert.equal(versionCodeOf('3.14.0-beta'), 31400)
  const bottom = nextSort(false, 100, 200)
  assert.ok(bottom < 100, 'bottom append lands below the current minimum')
  assert.equal(nextSort(true, undefined, 300), 812)
})

test('core: parseSubtasks / isImageName / firstImageOfList / formatDayLabel', () => {
  assert.deepEqual(parseSubtasks('[{"text":"a","checked":true}]'), [{ text: 'a', checked: true }])
  assert.deepEqual(parseSubtasks('not json'), [])
  assert.equal(isImageName('a.PNG'), true)
  assert.equal(isImageName('a.pdf'), false)
  assert.equal(firstImageOfList('[{"name":"x.pdf"},{"name":"y.jpg"}]').name, 'y.jpg')
  assert.equal(formatDayLabel(Date.now(), Date.now()), '今天')
})

/* ---------- tomatoShared (shared pomodoro completion decision: cross-window-idempotent pure logic) ---------- */
import { remainSecOf, phaseToken, dedupeById } from '../../../renderer/js/utils/tomatoShared.js'

test('tomato: remainSecOf countdown/boundaries', () => {
  const t0 = 1756344000000
  // 25-minute focus: after 65s elapsed, 23:55 remains
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 + 65000), 25 * 60 - 65)
  // The 5-minute rest is computed from restTime
  assert.equal(remainSecOf('startRestTime', t0, 25, 5, t0 + 10000), 5 * 60 - 10)
  // Both expiry and overtime clamp to 0
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 + 25 * 60000), 0)
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 + 99 * 60000), 0)
  // Non-running state / no startedAt -> null (not part of the countdown)
  assert.equal(remainSecOf('default', 0, 25, 5), null)
  assert.equal(remainSecOf('startTomatoTime', 0, 25, 5), null)
})

test('tomato: phaseToken phase identity', () => {
  assert.equal(phaseToken('startTomatoTime', 123), 'startTomatoTime:123')
  // After resume/giveUp the changed startedAt is a new identity, so the old token cannot be mistakenly matched
  assert.notEqual(phaseToken('startTomatoTime', 123), phaseToken('startTomatoTime', 456))
})

test('tomato: dedupeById record dedup (multi-window concurrency lands only one)', () => {
  const a = { tomatoId: 'tmt_f_1', succeed: true }
  const dup = { tomatoId: 'tmt_f_1', succeed: true }
  const b = { tomatoId: 'tmt_f_2', succeed: false }
  const noId = { succeed: false }
  const out = dedupeById([a, dup, b, noId])
  assert.equal(out.length, 3)
  assert.equal(out.filter(r => r.tomatoId === 'tmt_f_1').length, 1)
  assert.deepEqual(dedupeById(null), [])
})

/* ---------- milestones (project milestones, meta shared by UI/CLI) ---------- */
import { parseMilestoneDate, milestoneState, saveMilestones } from '../../../renderer/js/utils/milestones.js'

test('milestones: date parsing YYYY-MM-DD / MM-DD / today / +Nd', () => {
  const d1 = parseMilestoneDate('2026-09-15')
  assert.equal(dayjs(d1).format('YYYY-MM-DD'), '2026-09-15')
  const d2 = parseMilestoneDate('09-15')
  assert.equal(dayjs(d2).format('MM-DD'), '09-15') // current year filled in
  assert.equal(dayjs(parseMilestoneDate('today')).format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD'))
  const d4 = parseMilestoneDate('+14d')
  assert.equal(dayjs(d4).diff(dayjs().startOf('day'), 'day'), 14)
  assert.equal(parseMilestoneDate('乱写'), null)
  assert.equal(parseMilestoneDate(''), null)
  // Normalized to 00:00 of that day
  assert.equal(dayjs(parseMilestoneDate('2026-09-15')).format('HH:mm:ss'), '00:00:00')
})

test('milestones: status decision done/today/future', () => {
  const today = +dayjs().startOf('day')
  assert.equal(milestoneState({ date: today - DAY }, today), 'done')
  assert.equal(milestoneState({ date: today }, today), 'today')
  assert.equal(milestoneState({ date: today + DAY }, today), 'future')
})

test('milestones: saveMilestones sanitizes, sorts, fills ids (returns sanitized result even without todoAPI)', () => {
  const out = saveMilestones(1, [
    { title: '后', date: 200 },
    null,
    { title: '先', date: 100 },
    { title: '', date: 300 }
  ])
  assert.deepEqual(out.map(m => m.title), ['先', '后'])
  assert.ok(out.every(m => m.id && typeof m.date === 'number'))
})

import { selectPrunes } from '../../../src/main/autoBackup.js'

test('autoBackup: GFS tiered prune selection', () => {
  const names = []
  for (let i = 0; i < 30; i++) { const d = new Date(Date.now() - i * 60000); const p = n => String(n).padStart(2, '0'); names.push('auto-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json') }
  for (let day = 20; day <= 40; day++) { const d = new Date(Date.now() - day * 86400000); const p = n => String(n).padStart(2, '0'); names.push('auto-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-120000.json') }
  names.push('evt-purge-20260801-000000.json', 'evt-purge-20260802-000000.json', 'evt-import-20260803-000000.json')
  const prunes = selectPrunes(names, { recent: 24, dailyDays: 14, weeklyWeeks: 8, eventKeep: 10 })
  const kept = names.filter(n => !prunes.includes(n))
  assert.equal(kept.length, names.length - prunes.length)
  // The most recent 24 are always kept
  const sortedAuto = names.filter(n => n.startsWith('auto-')).sort().reverse()
  for (const n of sortedAuto.slice(0, 24)) assert.ok(!prunes.includes(n), 'recent should keep ' + n)
  // Event snapshots keep up to 10 per group
  for (const n of names.filter(x => x.startsWith('evt-'))) assert.ok(!prunes.includes(n))
  // Pruning deletes only the backup files themselves
  for (const n of prunes) assert.ok(n.endsWith('.json'))
})

/* ---------- N2/N3: milestone progress and due-soon warnings ---------- */
import { milestoneProgress, dueStateOf } from '../../../renderer/js/utils/milestones.js'

test('milestones: linked-task progress = completion ratio; null when nothing linked', () => {
  const tasks = [
    { taskId: 'a', complete: true },
    { taskId: 'b', complete: false },
    { taskId: 'c', complete: true }
  ]
  // Nonexistent task ids (e.g. hard-deleted) are not counted in the total
  assert.deepEqual(milestoneProgress({ taskIds: ['a', 'b', 'x'] }, tasks), { done: 1, total: 2, pct: 50 })
  assert.equal(milestoneProgress({ taskIds: [] }, tasks), null)
})

test('milestones: due-soon warning three states (today/overdue/within 3 days)', () => {
  const t0 = +dayjs().startOf('day')
  assert.equal(dueStateOf(t0 - 864e5, t0), 'overdue')
  assert.equal(dueStateOf(t0, t0), 'soon')
  assert.equal(dueStateOf(t0 + 3 * 864e5, t0), 'soon')
  assert.equal(dueStateOf(t0 + 4 * 864e5, t0), 'ok')
})

test('tomato: giveUp records the abandon reason (may be empty); repeated give-up in the same phase does not double-book', async () => {
  const tomato = (await import('../../../renderer/js/store/tomato.js')).default
  const commits = []
  const st = { status: 'startTomatoTime', startedAt: Date.now() - 61000, tomatoTime: 25, restTime: 5,
    attachTodo: { taskId: 't1', taskContent: '任务X' }, tomatoRecordList: [], unSyncTomatoRecordList: [] }
  // The patch must actually be applied (giveUp completion resets status - real store semantics; not applying it would leave the second give-up with a running state)
  const ctx = { state: st, commit: (t, p) => { if (t === 'addRecord') commits.push(p); else Object.assign(st, p) }, dispatch: async () => {} }
  await tomato.actions.giveUp(ctx, { record: true, reason: '  会议  ' })
  assert.equal(commits[0].abandonReason, '会议')
  assert.equal(commits[0].succeed, false)
  assert.equal(st.status, 'default', 'reset after give-up')
  // Triggering give-up after the state reset: nothing running to abandon, so no second record
  await tomato.actions.giveUp(ctx, { record: true, reason: '' })
  assert.equal(commits.length, 1, 'repeated give-up after reset does not double-book')
})
