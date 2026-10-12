/**
 * c-wave UI fixes (2026-10-13, agent F3 组件/视图域) — regression guards.
 * 1. onboarding tour pips selector was a dead link (.td-tomcount removed by the 2026-09-03
 *    integrated-capsule refactor; runTour silently returns false on empty steps) — every tour
 *    step selector must resolve in a real component source.
 * 2. journey seed task had no cleanup path — finishAll must withdraw the untouched seed task.
 * 3. undated task rows lost the whole .td-right strip (tomato capsule / quick delete) because
 *    the container's v-if also gated on dateLabel (empty for undated tasks).
 * 4. td-meta meta icons (repeat / attachments / focus minutes) never revealed on hover/focus.
 * 5. context menu offered move-to-today/postpone on COMPLETED tasks (tomato item had the
 *    !t.complete guard, the move branch didn't).
 * Run: node --test tests/unit/components/c-wave-ui-20261013.test.mjs
 */
import '../../setup.mjs' // node-env shims (dayjs / i18n lexicon / localStorage)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- #1 tour step selectors must exist in real component sources ---------- */

test('every tour step selector resolves in a real component template (no dead links)', () => {
  const toursSrc = read('renderer/js/utils/onboardingTours.js')
  // The refactored-away class must not come back
  assert.ok(!toursSrc.includes('.td-tomcount'), 'dead .td-tomcount selector reintroduced')
  const selectors = [...toursSrc.matchAll(/element:\s*'([^']+)'/g)].map(m => m[1])
  assert.ok(selectors.length >= 4, `expected tour selectors, got ${selectors.length}`)
  // selector -> component sources where it must literally exist
  const homes = {
    '.td-tom': ['renderer/js/components/TodoItem.vue'], // integrated capsule (2026-09-03), replaced td-tomcount
    '.tomato-timer__play': ['renderer/js/components/TomatoBar.vue'],
    '.day-rail': ['renderer/js/components/DayRail.vue'],
    '.ep-attach-bar': ['renderer/js/components/edit-panel/EpAttachments.vue', 'renderer/js/components/EditPanel.vue']
  }
  for (const sel of selectors) {
    const candidates = homes[sel] || []
    if (!candidates.length) continue // steps without a home list (e.g. future elementless notices) — nothing to assert
    const found = candidates.some(p => read(p).includes(sel))
    assert.ok(found, `tour selector '${sel}' not found in any of: ${candidates.join(', ')}`)
  }
  assert.ok(selectors.includes('.td-tom'), 'pips tour must target the live .td-tom capsule')
})

/* ---------- #2 journey seed task cleanup ---------- */

const mod = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/onboardingTours.js')).href)
const { tt } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/core.js')).href)
const seedText = () => tt('statsH.Onboarding.jSeedTask')

function seedHarness (row) {
  const dispatched = []
  const store = {
    dispatched,
    state: { todo: { todoList: row ? [row] : [] } },
    dispatch (action, payload) { dispatched.push({ action, payload }); return Promise.resolve() }
  }
  globalThis.window.appUI = { $store: store }
  return { store, dispatched }
}
const SEED_LS = 'onboardingJourneySeedTaskId'

const LS = () => globalThis.localStorage

test('cleanupJourneySeed: untouched seed task is soft-deleted via todo/deleteTodo', async () => {
  const row = { taskId: 7, taskContent: seedText(), complete: false, delete: false }
  const { dispatched } = seedHarness(row)
  LS().setItem(SEED_LS, '7')
  assert.equal(mod.cleanupJourneySeed(), true)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].action, 'todo/deleteTodo')
  assert.equal(dispatched[0].payload.taskId, 7)
  assert.equal(LS().getItem(SEED_LS), null, 'seed marker must be consumed')
  // Marker is single-shot: a second exit must not re-delete
  assert.equal(mod.cleanupJourneySeed(), false)
})

test('cleanupJourneySeed: user-edited / completed / recycled seed is never touched', async () => {
  for (const row of [
    { taskId: 7, taskContent: seedText() + ' (改过)', complete: false, delete: false }, // adopted by the user
    { taskId: 7, taskContent: seedText(), complete: true, delete: false }, // already done
    { taskId: 7, taskContent: seedText(), complete: false, delete: true } // already in the recycle bin
  ]) {
    const { dispatched } = seedHarness(row)
    LS().setItem(SEED_LS, '7')
    assert.equal(mod.cleanupJourneySeed(), false, `guard must hold for ${JSON.stringify(row)}`)
    assert.equal(dispatched.length, 0)
    assert.equal(LS().getItem(SEED_LS), null, 'marker consumed either way (no stale retry)')
  }
})

test('finishAll is wired to the seed cleanup (source assertion)', () => {
  const src = read('renderer/js/utils/onboardingTours.js')
  const m = src.match(/const finishAll = \(\) => \{[\s\S]*?\n[ \t]{2}\}/)
  assert.ok(m, 'finishAll body not found')
  assert.match(m[0], /cleanupJourneySeed\(\)/, 'finishAll must call cleanupJourneySeed (✕/skip/timeout/done all funnel here)')
  assert.match(src, /rememberSeed\(\)/, 'seed taskId must be remembered after the seed renders')
})

/* ---------- #3 undated rows keep the whole .td-right strip ---------- */

test('td-right container no longer gated on dateLabel; td-datetime gates on dateLabel||timeLabel', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const rightLine = src.split('\n').find(l => l.includes("class=\"td-right\"") && l.includes('v-if'))
  assert.ok(rightLine, 'td-right container with v-if not found')
  assert.ok(rightLine.includes('v-if="showDateBadge"'), `td-right v-if must be showDateBadge only, got: ${rightLine.trim()}`)
  assert.ok(!rightLine.includes('dateLabel'), 'td-right container must not be hidden for undated tasks')
  const dtLine = src.split('\n').find(l => l.includes('class="td-datetime"'))
  assert.ok(dtLine && dtLine.includes('v-if="dateLabel || timeLabel"'), 'td-datetime must keep rendering when only timeLabel is present')
})

/* ---------- #4 td-meta icons reveal on hover / keyboard focus ---------- */

test('td-meta .td-ico and .td-snow have hover + focus-within reveal rules', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const style = src.slice(src.indexOf('<style>'))
  for (const sel of ['.td-item:hover .td-meta .td-ico', '.td-item:focus-within .td-meta .td-ico',
    '.td-item:hover .td-meta .td-snow', '.td-item:focus-within .td-meta .td-snow']) {
    assert.ok(style.includes(sel), `missing reveal selector: ${sel}`)
  }
  const rule = style.match(/\.td-item:hover \.td-meta \.td-ico[^}]*\}/)
  assert.ok(rule && rule[0].replace(/\s+/g, ' ').includes('opacity: 1'), 'reveal rule must set opacity: 1')
})

/* ---------- #5 context menu hides move items for completed tasks ---------- */

const menuMod = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/taskMenu.js')).href)
const vmStub = {
  $t: k => k,
  $message: {},
  $store: { state: { todo: { todoList: [] } } }
}

test('buildTaskMenu: completed task has no move items; live task keeps them', () => {
  const done = menuMod.buildTaskMenu(vmStub, { taskId: 'a', taskContent: 'x', complete: true })
  const labels = done.map(i => i.label || '')
  assert.ok(!labels.includes('statsE.TodoItem.moveToToday'), 'completed task must not offer move-to-today')
  assert.ok(!labels.includes('statsE.TodoItem.postponeToTomorrow'), 'completed task must not offer postpone')
  assert.ok(labels.includes('statsJ.TodoItem.markDone') || labels.includes('statsE.TodoItem.markIncomplete'), 'complete toggle stays')

  const live = menuMod.buildTaskMenu(vmStub, { taskId: 'b', taskContent: 'y', complete: false })
  const liveLabels = live.map(i => i.label || '')
  assert.ok(liveLabels.includes('statsE.TodoItem.moveToToday'))
  assert.ok(liveLabels.includes('statsE.TodoItem.postponeToTomorrow'))
})
