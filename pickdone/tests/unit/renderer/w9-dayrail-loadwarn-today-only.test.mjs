/**
 * [w9-loadwarn] DayRail schedule-load warning counts TODAY's plan only.
 *
 * User-reported 2026-10-26: the rail's 过载 badge read 132/10 on a lightly planned day —
 * its input concat'd views.recent.expiredUncompleted (up to 30d of overdue backlog) into
 * "today's planned load", so any accumulated backlog made the warning fire forever and
 * disagreed with ProjectOverviewView's load badge (today-only since day one). The warning
 * now measures views.todayTodoList only; overdue backlog stays visible as the Today
 * page's expired groups without counting as today's plan.
 *
 * Source contract + evaluated-computed behavior (same harness family as maint-d26).
 * Run: node --test tests/unit/renderer/w9-dayrail-loadwarn-today-only.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---- env mocks (before renderer imports) ---- */
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' } }

const dayjs = (await import('dayjs')).default
const { dayPlannedLoad, loadLevel } = await import('../../../renderer/js/utils/loadWarn.js')

/** Evaluate a .vue <script> block with its imports injected (same harness as maint-d26) */
function loadSFC (rel, inject = {}) {
  const src = read(rel)
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, rel + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+.*$\n?/gm, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(inject)
  return new Function(...names, code)(...names.map(k => inject[k]))
}

const inject = {
  FMT: { date: 'YYYY-MM-DD' },
  dayjs,
  FOCUS_INPUT_MAX_MINUTES: 600,
  localDayKey: ts => ts,
  toggleCompleteWithUndo: () => {},
  removeWithUndo: () => {},
  taskContextMenu: () => {},
  dayPlans: {},
  dayPlannedLoad,
  loadLevel,
  getEstimate: id => ({ t1: 2, t2: 3 }[id] || 1),
  mmToHHmm: m => `${Math.floor(m / 60)}:${m % 60}`,
  today0: () => +dayjs().startOf('day'),
  dayShift: (ts, d) => ts + d * 86400000,
  roleButtonActivate: () => () => {}
}

test('W9 source contract: DayRail loadWarn no longer pulls expiredUncompleted into the load', () => {
  const DayRail = loadSFC('renderer/js/components/DayRail.vue', inject)
  const body = DayRail.computed.loadWarn.toString()
  assert.ok(!body.includes('expiredUncompleted'),
    'DayRail loadWarn must not read views.recent.expiredUncompleted (backlog is not today\'s plan)')
  assert.ok(body.includes('dayPlannedLoad(v.todayTodoList'),
    'DayRail loadWarn must measure views.todayTodoList only')
})

test('W9 behavior: backlog-heavy views yield a small today-only planned load', () => {
  const DayRail = loadSFC('renderer/js/components/DayRail.vue', inject)
  const loadWarn = DayRail.computed.loadWarn
  const views = {
    // 2 tasks scheduled today at estimates 2+3 = 5 planned
    todayTodoList: [{ taskId: 't1' }, { taskId: 't2' }],
    // 30 days of overdue backlog, ~127 estimated tomatoes — must NOT be counted
    recent: { expiredUncompleted: Array.from({ length: 30 }, (_, i) => ({ taskId: 'backlog' + i })) }
  }
  const ctx = {
    isViewingToday: true,
    $store: { state: { todo: { views }, settings: { dailyLoadWarnThreshold: 10 } } },
    $t: (key, p) => key + ':' + JSON.stringify(p)
  }
  const res = loadWarn.call(ctx)
  // 5 <= threshold 10: no warning, despite 127 tomatoes of backlog sitting in expiredUncompleted
  assert.equal(res.active, false, 'a 5-tomato today plan must not warn at threshold 10')
  assert.equal(res.badge, '')

  // Sanity the other direction: a genuinely overloaded today still warns (5 + heavy day)
  ctx.$store.state.todo.views.todayTodoList =
    [{ taskId: 't1' }, { taskId: 't2' }].concat(Array.from({ length: 5 }, (_, i) => ({ taskId: 'today' + i })))
  const warn = loadWarn.call(ctx)
  // 2+3 + 5 backfill tasks at fallback estimate 1 each = 10 <= 10 -> ok; add one more -> warn
  assert.equal(warn.active, false)
  ctx.$store.state.todo.views.todayTodoList.push({ taskId: 'todayX' })
  const warn2 = loadWarn.call(ctx)
  assert.equal(warn2.active, true, '11 planned tomatoes > threshold 10 must warn')
  assert.match(warn2.badge, /loadR\.warnBadge/)
})

test('W9 behavior: threshold 0 (off) and non-today browsing render no warning UI', () => {
  const DayRail = loadSFC('renderer/js/components/DayRail.vue', inject)
  const loadWarn = DayRail.computed.loadWarn
  const views = { todayTodoList: [{ taskId: 't1' }], recent: { expiredUncompleted: [] } }
  const ctx = {
    isViewingToday: true,
    $store: { state: { todo: { views }, settings: { dailyLoadWarnThreshold: 0 } } },
    $t: k => k
  }
  assert.equal(loadWarn.call(ctx).active, false)
  ctx.isViewingToday = false
  ctx.$store.state.settings.dailyLoadWarnThreshold = 10
  assert.equal(loadWarn.call(ctx).active, false)
})
