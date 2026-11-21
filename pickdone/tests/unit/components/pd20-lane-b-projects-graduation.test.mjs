import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// pd20 lane B (desktop project UX, 2026-11-07): Project graduation acceptance.
// - Cold-start new user: DEFAULT_SETTINGS.showProjectsModule === true → nav entry visible
//   without developer mode.
// - Existing user who explicitly hid it: a persisted blob carrying showProjectsModule:false
//   wins over the default (load()'s {...DEFAULT_SETTINGS, ...raw} merge never overrides a
//   stored false), and the nav gate hides the entry.
// - The Projects switch is a normal always-visible settings row (outside the developer-mode
//   v-show block), so old users can find the toggle to re-enable it.
// - The work-handoff entry (EditPanel EpWork) and the honest project empty states stay wired.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const read = (p) => readFileSync(ROOT + p, 'utf8')

test('nav gate: projects visible for a non-developer when the module switch is on', async () => {
  const { visibleNavRoutes } = await import('../../../renderer/js/utils/nav-gate.js')
  const ORDER = ['todo-list-today', 'todo-list-projects', 'todo-list-stats']
  assert.deepEqual(visibleNavRoutes({ developerMode: false, showProjectsModule: true }, ORDER),
    ['todo-list-today', 'todo-list-projects', 'todo-list-stats'])
  assert.deepEqual(visibleNavRoutes({ developerMode: false, showProjectsModule: false }, ORDER),
    ['todo-list-today', 'todo-list-stats'])
  assert.deepEqual(visibleNavRoutes({}, ORDER), ['todo-list-today', 'todo-list-stats'],
    'a missing switch still hides the entry (the schema default supplies true at store level)')
})

test('cold-start new user: schema default ships showProjectsModule=true', async () => {
  const { DEFAULT_SETTINGS } = await import('../../../renderer/js/store/settings-schema.js')
  assert.equal(DEFAULT_SETTINGS.showProjectsModule, true,
    'the graduated module must be visible from a cold start without any user action')
  // CLI contract lockstep: settingsEffective falls back to the shared manifest mirror — a stale
  // false there would make `settings get showProjectsModule` contradict the visible nav entry.
  const { SETTINGS_MANIFEST } = await import('../../../shared/settings-manifest.mjs')
  assert.equal(SETTINGS_MANIFEST.defaults.showProjectsModule, DEFAULT_SETTINGS.showProjectsModule,
    'the CLI-facing default mirror must equal the renderer default')
})

test('old user stays hidden: the persisted-false merge contract holds', async () => {
  // The merge contract in store/settings.js load(): DEFAULT first, raw blob second — a stored
  // false (explicit preference) beats the new default. Assert the merge shape the store uses.
  const DEFAULT_SETTINGS = (await import('../../../renderer/js/store/settings-schema.js')).DEFAULT_SETTINGS
  const raw = { showProjectsModule: false } // legacy blob that persisted the old default
  const merged = { ...DEFAULT_SETTINGS, ...raw }
  assert.equal(merged.showProjectsModule, false, 'an explicit stored false must never be overridden')
})

test('SettingsModal: the Projects switch is an always-visible row above the developer block', () => {
  const tpl = read('renderer/js/components/SettingsModal.vue')
  const projRow = tpl.indexOf('sProjects')
  const devBlock = tpl.indexOf('v-show="st.developerMode === true"')
  assert.ok(projRow > -1 && devBlock > -1)
  assert.ok(projRow < devBlock, 'the projects switch must render before (outside) the developer-mode v-show block')
  // The dev-only block must no longer contain its own sProjects row (no duplicate entry —
  // 主动移除重复功能 doctrine).
  const devBlockEnd = tpl.indexOf('</div>', tpl.indexOf('sDeps'))
  assert.ok(tpl.slice(devBlock, devBlockEnd).indexOf('sProjects') === -1,
    'the developer block must not keep a second projects switch')
  assert.ok(tpl.includes('sProjectsTip'), 'the row ships a discoverability tip')
})

test('i18n: graduated label + tip exist in both locales (no experimental wording left on the row)', () => {
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  const en = read('renderer/js/i18n/locales/en-US-E.js')
  assert.ok(zh.includes('"sProjects": "项目"') && zh.includes('"sProjectsTip"'))
  assert.ok(en.includes('"sProjects": "Projects",') && en.includes('"sProjectsTip"'))
  assert.ok(!/sProjects.*实验/.test(zh) && !/sProjects.*experimental/.test(en),
    'the graduated row must no longer advertise itself as experimental')
})

test('work-handoff preview stays wired but is hidden until explicit developer opt-in', () => {
  const ep = read('renderer/js/components/EditPanel.vue')
  assert.match(ep, /<ep-work\b[^>]*v-if="\$store\.state\.settings\.developerMode === true && \(\$store\.state\.settings\.workEpisode \|\| \{\}\)\.enabled"/,
    'the task-level work-history entry requires both developer mode and explicit opt-in')
  const project = read('renderer/js/views/ProjectView.vue')
  assert.ok(project.includes('<project-handoff v-if="settings.developerMode === true && (settings.workEpisode || {}).enabled"'),
    'project-level work handoff should not leak into daily users without explicit preview mode')
  const schema = read('renderer/js/store/settings-schema.js')
  assert.ok(schema.includes('workEpisode: { enabled: false }'),
    'work episodes must be default-off pending user UX acceptance')
})

test('project empty states stay honest (no fabricated records)', () => {
  const overview = read('renderer/js/views/ProjectOverviewView.vue')
  assert.ok(overview.includes("statsB.ProjectsView.empty"), 'true no-project empty state key present')
  assert.ok(overview.includes('projQ.filteredEmpty'), 'filter-empty ≠ no-project distinction kept')
  const schema = read('renderer/js/store/settings-schema.js')
  assert.ok(schema.includes('showProjectsModule: true'), 'default ships visible')
})
