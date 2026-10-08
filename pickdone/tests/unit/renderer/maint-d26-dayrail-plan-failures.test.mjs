/**
 * [maint/d26] DayRail plan-chip failure visibility + future-plan prune contract, and
 * TodayXView observed startFocus dispatch.
 *
 * - DayRail plan-chip writes rolled optimistic state back on failure with ZERO user feedback
 *   (violating the D22/D23 "failure must be visible" contract): every .catch now surfaces a
 *   toast (reportPlanFail) before resyncing from the library.
 * - DayRail.prune physically deleted plan buckets more than 31 days in the future via
 *   db-plan-ops DELETE, contradicting its own "never delete future" contract; the keep window
 *   now spans [today-7d, today+366d] (~1 year pragmatic cap on the reachable horizon).
 * - TodayXView.startSelected was fire-and-forget; it now goes through observeDispatch like
 *   TomatoBar.onPlayClick so a failed startFocus surfaces a toast.
 *
 * SFC scripts are evaluated with the same loadSFC harness family as maint-0927-domainA.
 * Run: node --test tests/unit/renderer/maint-d26-dayrail-plan-failures.test.mjs
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
const core = await import('../../../renderer/js/utils/core.js')
const bounds = await import('../../../renderer/js/utils/todayBounds.js')
const { localDayKey } = await import('../../../shared/date-key.mjs')
const rbk = await import('../../../renderer/js/utils/roleButtonKey.js')

/** Evaluate a .vue <script> block with its imports injected (same harness as maint-0927-domainA) */
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

const DayRail = loadSFC('renderer/js/components/DayRail.vue', {
  FMT: core.FMT, dayjs, FOCUS_INPUT_MAX_MINUTES: 600,
  localDayKey,
  toggleCompleteWithUndo: () => {}, removeWithUndo: () => {}, taskContextMenu: () => {},
  dayPlans: await import('../../../renderer/js/utils/dayPlans.js'),
  dayPlannedLoad: () => 0, loadLevel: () => '',
  getEstimate: () => 1, mmToHHmm: () => '00:00',
  today0: bounds.today0, dayShift: bounds.dayShift,
  roleButtonActivate: rbk.roleButtonActivate
})

/* ===== Prune: future plans survive ===== */

test('prune keeps plans 45 days out (old +31d bound physically deleted them)', () => {
  const future = dayjs().add(45, 'day').startOf('day').valueOf()
  const key = localDayKey(future)
  const ctx = { plans: { [key]: { t1: [{ mm: '09:00', id: 'p1' }] } } }
  DayRail.methods.prune.call(ctx)
  assert.ok(ctx.plans[key], 'a plan 45 days out must survive (the old +31d window deleted it)')
})

test('prune keeps plans just inside the ~1y cap and drops far-future + expired buckets', () => {
  const nearCap = dayjs().add(360, 'day').startOf('day').valueOf()
  const beyondCap = dayjs().add(400, 'day').startOf('day').valueOf()
  const expired = dayjs().subtract(10, 'day').startOf('day').valueOf()
  const kCap = localDayKey(nearCap)
  const kBeyond = localDayKey(beyondCap)
  const kExpired = localDayKey(expired)
  const ctx = { plans: { [kCap]: {}, [kBeyond]: {}, [kExpired]: {} } }
  DayRail.methods.prune.call(ctx)
  assert.ok(ctx.plans[kCap], '360 days out is inside the keep window')
  assert.ok(!ctx.plans[kBeyond], 'beyond the ~1y cap the GC still runs')
  assert.ok(!ctx.plans[kExpired], 'expired buckets are still pruned')
})

/* ===== Plan-chip failures must be visible ===== */

test('reportPlanFail surfaces the shared actionFailedMsg toast with the error detail', () => {
  const toasts = []
  const ctx = {
    $message: { error: s => toasts.push(s) },
    $t: k => (k === 'statsH.main.actionFailedMsg' ? 'Action failed: ' : k)
  }
  DayRail.methods.reportPlanFail.call(ctx, new Error('library busy'))
  assert.equal(toasts.length, 1)
  assert.match(toasts[0], /Action failed: /)
  assert.match(toasts[0], /library busy/)
})

test('reportPlanFail tolerates a missing $message (aux-window safety)', () => {
  assert.doesNotThrow(() => DayRail.methods.reportPlanFail.call({ $message: null, $t: k => k }, null))
})

test('every plan-chip write .catch reports the failure AND resyncs (rollback stays, silence gone)', () => {
  const src = read('renderer/js/components/DayRail.vue')
  assert.match(src, /const resync = \(\) => \{ this\.reportPlanFail\(\); this\._onPlansChanged\(\) \}/,
    'onDrop write-failure path toasts before resyncing')
  const catches = src.match(/\.catch\(e => \{ this\.reportPlanFail\(e\); this\._onPlansChanged\(\) \}\)/g) || []
  assert.ok(catches.length >= 2, 'removeChips + undo-addChips failures both toast (found ' + catches.length + ')')
  assert.doesNotMatch(src, /\.catch\(\(\) => this\._onPlansChanged\(\)\)/, 'no silent plan-chip catch remains')
})

/* ===== TodayXView: observed startFocus ===== */

test('TodayXView.startSelected routes through observeDispatch and toasts on failure', async () => {
  const { observeDispatch } = await import('../../../renderer/js/utils/dispatchObserved.js')
  const TodayXView = loadSFC('renderer/js/views/TodayXView.vue', {
    FMT: core.FMT, dayjs, getEstimate: () => 1,
    formatMMSS: (await import('../../../renderer/js/utils/tomatoShared.js')).formatMMSS,
    hiddenCount: (await import('../../../renderer/js/utils/limits.js')).hiddenCount,
    remainingSecOfState: (await import('../../../renderer/js/store/tomato.js')).remainingSecOfState,
    DayDateStrip: {}, DayRail: {}, TodoGroups: {}, observeDispatch
  })
  const dispatched = []
  const failingStore = {
    dispatch (action) {
      dispatched.push(action)
      return Promise.reject(new Error('ipc down'))
    }
  }
  const toasts = []
  TodayXView.methods.startSelected.call({
    $store: failingStore,
    $message: { error: s => toasts.push(s) },
    $t: k => (k === 'statsH.main.actionFailedMsg' ? 'Action failed: ' : k)
  })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(dispatched, ['tomato/startFocus'], 'the dispatch still happens (via observeDispatch)')
  assert.equal(toasts.length, 1, 'a failed startFocus must surface a toast, not idle silently')
  assert.match(toasts[0], /ipc down/)
})

test('TodayXView imports observeDispatch (static anchor)', () => {
  const src = read('renderer/js/views/TodayXView.vue')
  assert.match(src, /import \{ observeDispatch \} from '\.\.\/utils\/dispatchObserved\.js'/)
})
