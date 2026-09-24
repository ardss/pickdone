/**
 * Wave-5 P2 (refactor, behavior-preserving): CategoryView.groups() and ProjectView.groups()
 * carried ~27 verbatim lines each (same rangeDays two-level expired windows, same bucket
 * comparator taskSort desc -> createTime desc, same 7 group buckets with identical
 * color/hasSettings/hasRecomplete props). Single source now: utils/expiryGroups.js
 * buildExpiryGroups, parameterized by i18n keys (statsI/statsE vs statsB) and ProjectView's
 * trailing projDone full-completed fallback. Group keys (catExpDone..catNoDate) are an unchanged
 * UI contract.
 * Run: node --test tests/unit/renderer/wave5-expiry-groups.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const require_ = createRequire(import.meta.url)

const dayjs = require_('dayjs')
const today = +dayjs().startOf('day')
const DAY_MS = 86400000

const { buildExpiryGroups } = await import('../../../renderer/js/utils/expiryGroups.js')
const { rangeDays } = await import('../../../renderer/js/utils/core.js')

// Original CategoryView.groups body, transplanted verbatim (pre-refactor) with $t and calTitle stubbed
function legacyCategoryGroups (list, s, todayTs, t) {
  const R1 = rangeDays(s.expiredCompletedTodoRange, 7)
  const R2 = rangeDays(s.expiredUncompletedTodoRange, 30)
  const bucket = f => list.filter(f).sort((a, b) => b.taskSort - a.taskSort || b.createTime - a.createTime)
  const g = []
  const expDone = bucket(x => x.complete && x.dayStart && x.dayStart < todayTs && x.dayStart >= todayTs - R1 * DAY_MS)
  if (expDone.length) g.push({ key: 'catExpDone', title: t('statsI.CategoryView.expDoneTitle', { r: R1 }), todos: expDone, showDate: true, hasSettings: true })
  const expUndo = bucket(x => !x.complete && x.dayStart && x.dayStart < todayTs && x.dayStart >= todayTs - R2 * DAY_MS).sort((a, b) => a.dayStart - b.dayStart)
  if (expUndo.length) g.push({ key: 'catExpUndo', title: t('statsI.CategoryView.expUndoTitle', { r: R2 }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
  const td = bucket(x => !x.complete && x.dayStart === todayTs)
  if (td.length) g.push({ key: 'catToday', title: 'cal:' + todayTs, todos: td, color: 'color3' })
  const tm = bucket(x => x.dayStart === todayTs + DAY_MS)
  if (tm.length) g.push({ key: 'catTomorrow', title: 'cal:' + (todayTs + DAY_MS), todos: tm, color: 'color3' })
  const dat = bucket(x => x.dayStart === todayTs + 2 * DAY_MS)
  if (dat.length) g.push({ key: 'catDat', title: 'cal:' + (todayTs + 2 * DAY_MS), todos: dat, color: 'color3' })
  const up = bucket(x => !x.complete && x.dayStart > todayTs + 2 * DAY_MS)
  if (up.length) g.push({ key: 'catUpcoming', title: t('statsE.CategoryView.upcomingLabel'), todos: up, showDate: true, color: 'color3', hasSettings: true })
  const nd = bucket(x => !x.complete && !x.dayStart)
  if (nd.length) g.push({ key: 'catNoDate', title: t('statsE.CategoryView.noDateLabel'), todos: nd, hasSettings: true })
  return g
}

const mk = (id, over = {}) => ({ taskId: 't' + id, taskSort: 100 - id, createTime: 1000 - id, dayStart: 0, complete: false, ...over })

function fixtureList () {
  return [
    mk(1, { dayStart: today - 3 * DAY_MS, complete: true, completedAt: 1 }),              // expDone
    mk(2, { dayStart: today - 10 * DAY_MS }),                                             // expUndo
    mk(3, { dayStart: today }),                                                           // today
    mk(4, { dayStart: today + DAY_MS }),                                                  // tomorrow
    mk(5, { dayStart: today + 2 * DAY_MS }),                                              // day after
    mk(6, { dayStart: today + 5 * DAY_MS }),                                              // upcoming
    mk(7),                                                                                // noDate
    mk(8, { dayStart: today + 5 * DAY_MS, complete: true }),                              // completed upcoming: stays out of `up`, feeds projDone
    mk(9, { dayStart: today - 90 * DAY_MS, complete: true }),                             // beyond R1: NOT expDone
    mk(10, { dayStart: today - 60 * DAY_MS })                                             // beyond R2: NOT expUndo
  ]
}

const settings = { expiredCompletedTodoRange: 7, expiredUncompletedTodoRange: 30 }
const t = (k, p) => k + (p ? '(' + p.r + ')' : '')

test('buildExpiryGroups reproduces the legacy CategoryView grouping field-for-field (same R1/R2 windows, bucket order, props)', () => {
  const list = fixtureList()
  const legacy = legacyCategoryGroups(list, settings, today, t)
  const now = buildExpiryGroups({
    list, settings, today, t,
    keys: { expDone: 'statsI.CategoryView.expDoneTitle', expUndo: 'statsI.CategoryView.expUndoTitle', upcoming: 'statsE.CategoryView.upcomingLabel', noDate: 'statsE.CategoryView.noDateLabel' }
  })
  // calTitle-dependent titles compared by key+bucket membership, not literal text (dayjs locale)
  assert.deepEqual(now.map(g => g.key), legacy.map(g => g.key), 'same groups, same order')
  for (let i = 0; i < legacy.length; i++) {
    assert.deepEqual(now[i].todos.map(x => x.taskId), legacy[i].todos.map(x => x.taskId), `bucket membership+order of ${legacy[i].key}`)
    const { title: _drop, ...restLegacy } = legacy[i]
    const { title: _drop2, ...restNow } = now[i]
    void _drop; void _drop2
    assert.deepEqual(restNow, restLegacy, `non-title props of ${legacy[i].key} (color/showDate/hasSettings/hasRecomplete)`)
  }
})

test('buildExpiryGroups renders i18n titles through the injected keys (CategoryView statsI/statsE, ProjectView statsB) + projDone extra group', () => {
  const list = [mk(1, { dayStart: today - 3 * DAY_MS, complete: true }), mk(2, { dayStart: today - 10 * DAY_MS }), mk(3, { dayStart: today + 5 * DAY_MS, complete: true })]
  const calls = []
  const tt = (k, p) => { calls.push(p ? `${k}(${p.r})` : k); return k }
  // CategoryView shape: no extra group
  buildExpiryGroups({ list, settings, today, t: tt, keys: { expDone: 'statsI.CategoryView.expDoneTitle', expUndo: 'statsI.CategoryView.expUndoTitle', upcoming: 'statsE.CategoryView.upcomingLabel', noDate: 'statsE.CategoryView.noDateLabel' } })
  assert.ok(calls.includes('statsI.CategoryView.expDoneTitle(7)'), 'CategoryView expDone key used, range interpolated')
  assert.ok(calls.includes('statsI.CategoryView.expUndoTitle(30)'), 'CategoryView expUndo key used, range interpolated')
  assert.ok(!calls.some(c => c.startsWith('statsB.')), 'no ProjectView keys leak into the Category call')
  // ProjectView shape: statsB keys + projDone full-completed fallback with showDate
  calls.length = 0
  const g = buildExpiryGroups({
    list, settings, today, t: tt,
    keys: { expDone: 'statsB.ProjectView.expDoneTitle', expUndo: 'statsB.ProjectView.expUndoTitle', upcoming: 'statsB.ProjectView.upcoming', noDate: 'statsB.ProjectView.noDate' },
    extraGroups: [{ key: 'projDone', titleKey: 'statsB.ProjectView.done', filter: x => x.complete, props: { showDate: true } }]
  })
  assert.ok(calls.includes('statsB.ProjectView.expDoneTitle(7)') && calls.includes('statsB.ProjectView.done'), 'statsB keys used')
  const proj = g.find(x => x.key === 'projDone')
  assert.ok(proj, 'projDone fallback group emitted when it has members')
  assert.deepEqual(proj.todos.map(x => x.taskId), ['t1', 't3'], 'projDone carries ALL completed (not just the R1 window)')
  assert.deepEqual({ showDate: proj.showDate, hasSettings: proj.hasSettings }, { showDate: true, hasSettings: undefined }, 'projDone keeps its original props')
})

test('source anchors: both views delegate to buildExpiryGroups; contract keys preserved', () => {
  const read = p => readFileSync(path.join(ROOT, p), 'utf8')
  for (const p of ['renderer/js/views/CategoryView.vue', 'renderer/js/views/ProjectView.vue']) {
    const src = read(p)
    assert.match(src, /buildExpiryGroups/, p + ' delegates to the shared builder')
    assert.ok(!/const bucket = f => list\.filter/.test(src), p + ' no longer carries the inline bucket chain')
  }
  const util = read('renderer/js/utils/expiryGroups.js')
  for (const key of ['catExpDone', 'catExpUndo', 'catToday', 'catTomorrow', 'catDat', 'catUpcoming', 'catNoDate']) {
    assert.ok(util.includes("'" + key + "'"), 'shared UI contract key ' + key + ' preserved')
  }
})
