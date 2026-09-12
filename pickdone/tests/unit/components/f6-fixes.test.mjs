/**
 * Component/view fixes — round 6 maintenance wave (agent F3: components/views domain).
 * Regression tests: source-level assertions for template/aria/behavior fixes plus
 * i18n bilingual parity for newly added keys (same paradigm as component-r5-fixes.test.mjs).
 *
 * Run: node --test tests/unit/components/f6-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, 'renderer/js', p), 'utf8')

/* ---------------- i18n: bilingual parity + new fix keys ---------------- */

test('f6 i18n: every en-US shard has a zh-CN twin with identical key sets', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  // 2026-09-12: shard F merged into D and deleted — no shard is skipped anymore
  const enFiles = readdirSync(dir).filter(f => f.startsWith('en-US-'))
  for (const f of enFiles) {
    const zf = f.replace('en-US', 'zh-CN')
    const e = (await import(pathToFileURL(path.join(dir, f)).href)).default
    const z = (await import(pathToFileURL(path.join(dir, zf)).href)).default
    const flat = o => {
      const out = []
      const walk = (obj, pre) => Object.entries(obj).forEach(([k, v]) => {
        if (v && typeof v === 'object') walk(v, `${pre}${k}.`)
        else out.push(`${pre}${k}`)
      })
      walk(o, '')
      return out.sort()
    }
    assert.deepEqual(flat(e), flat(z), `${f} vs ${zf} key parity (flattened)`)
  }
})

test('f6 i18n: new fix keys exist in both languages with matching placeholders', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  const enA = await load('en-US-A.js'); const zhA = await load('zh-CN-A.js')
  for (const k of ['emptyHint', 'msLoading', 'removeDep', 'depRemoved']) {
    assert.ok(enA.statsA.DepView[k] && zhA.statsA.DepView[k], `statsA.DepView.${k}`)
  }
  assert.match(enA.statsA.DepView.removeDep, /\{a\}/)
  assert.match(zhA.statsA.DepView.removeDep, /\{a\}/)
  assert.match(enA.statsA.DepView.depRemoved, /\{a\}[\s\S]*\{b\}/)
  assert.match(zhA.statsA.DepView.depRemoved, /\{a\}[\s\S]*\{b\}/)
  const enB = await load('en-US-B.js'); const zhB = await load('zh-CN-B.js')
  for (const k of ['titleAria', 'bodyAria']) {
    assert.ok(enB.statsB.ProjectDocs[k] && zhB.statsB.ProjectDocs[k], `statsB.ProjectDocs.${k}`)
  }
  assert.ok(enB.statsB.ProjectView.tabsAria && zhB.statsB.ProjectView.tabsAria, 'statsB.ProjectView.tabsAria')
  const enQ = await load('en-US-Q.js'); const zhQ = await load('zh-CN-Q.js')
  for (const k of ['statusChanged', 'cancelConfirmTitle', 'cancelConfirmText', 'filteredEmpty', 'clearFilter']) {
    assert.ok(enQ.projQ[k] && zhQ.projQ[k], `projQ.${k}`)
  }
  assert.match(enQ.projQ.statusChanged, /\{s\}/)
  assert.match(zhQ.projQ.statusChanged, /\{s\}/)
})

/* ---------------- #1/#3/#4 ProjectDocs ---------------- */

test('f6 ProjectDocs: pending debounced save is flushed (not dropped) on catId switch and unmount', () => {
  const src = read('components/ProjectDocs.vue')
  assert.match(src, /flushPending \(/, 'flushPending method exists')
  assert.match(src, /catId \(\) \{ this\.flushPending\(\); this\.load\(\) \}/, 'catId watcher flushes before reload')
  assert.match(src, /beforeUnmount \(\) \{ this\.flushPending\(\) \}/, 'unmount flushes instead of bare clearTimeout')
  // flush must write under the key captured at queueSave time (prop already points at the new project)
  assert.match(src, /_pendingKey \|\| keyOf\(this\.catId\)/)
  assert.match(src, /this\._pendingKey = keyOf\(this\.catId\)/)
})

test('f6 ProjectDocs: title/body inputs carry i18n aria-labels', () => {
  const src = read('components/ProjectDocs.vue')
  assert.match(src, /:aria-label="\$t\('statsB\.ProjectDocs\.titleAria'\)"/)
  assert.match(src, /:aria-label="\$t\('statsB\.ProjectDocs\.bodyAria'\)"/)
})

test('f6 ProjectDocs: deletion goes through the removeWithUndo undo contract (no two-stage arm)', () => {
  const src = read('components/ProjectDocs.vue')
  assert.match(src, /import \{ removeWithUndo \} from '\.\.\/utils\/confirm\.js'/)
  assert.match(src, /removeWithUndo\(this,/, 'delDoc uses removeWithUndo')
  assert.ok(!/delArmed/.test(src), 'two-stage delArmed flow removed')
  assert.match(src, /this\.docs\.splice\(Math\.min\(idx, this\.docs\.length\), 0, doc\)/, 'undo restores at original position')
})

/* ---------------- #2/#9/#10/#11/#12/#13 DepView ---------------- */

test('f6 DepView: empty scope renders the empty-state hint', () => {
  const src = read('components/DepView.vue')
  assert.match(src, /v-if="!inScope\.length" class="depv-empty"/, 'dead .depv-empty CSS now wired')
  assert.match(src, /\$t\('statsA\.DepView\.emptyHint'\)/)
})

test('f6 DepView: filter chips expose aria-pressed', () => {
  const src = read('components/DepView.vue')
  assert.match(src, /:aria-pressed="projectId === null"/)
  assert.match(src, /:aria-pressed="projectId === p\.categoryId"/)
})

test('f6 DepView: milestone loading state is distinguished from the empty state', () => {
  const src = read('components/DepView.vue')
  assert.match(src, /msLoaded/, 'msLoaded flag exists')
  assert.match(src, /msLoaded \? \$t\('statsA\.DepView\.noMilestone'\) : \$t\('statsA\.DepView\.msLoading'\)/)
  assert.match(src, /this\.msLoaded = true/, 'flag set after load resolves')
})

test('f6 DepView: blocked/ready judgment uses the full live task table, not just inScope', () => {
  const src = read('components/DepView.vue')
  assert.match(src, /allLiveById \(\)/)
  const missing = src.slice(src.indexOf('missingOf (t)'), src.indexOf('completeTask (t)'))
  assert.match(missing, /this\.allLiveById\(\)/, 'missingOf builds byId from all live tasks')
  const helper = src.slice(src.indexOf('allLiveById ()'), src.indexOf('missingOf (t)'))
  assert.match(helper, /!t\.delete/, 'recycle-bin tasks excluded')
})

test('f6 DepView: posMap dead keys are pruned and wire bounds only count live cards', () => {
  const src = read('components/DepView.vue')
  const ensure = src.slice(src.indexOf('ensurePositions ()'), src.indexOf('tidyUp ()'))
  assert.match(ensure, /delete this\.posMap\[dead\]/, 'ensurePositions prunes dead keys')
  const draw = src.slice(src.indexOf('drawWires ()'))
  assert.match(draw, /liveIds\[b\]/, 'drawWires bounds skip dead posMap keys')
})

test('f6 DepView: context menu offers per-prerequisite "remove dependency" with undo', () => {
  const src = read('components/DepView.vue')
  assert.match(src, /removeDependency \(target, prereqId, name\)/)
  assert.match(src, /taskContextMenu\(this, t, e, null, extra\)/, 'extra items appended to the shared menu')
  assert.match(src, /\$t\('statsA\.DepView\.removeDep', \{ a: name \}\)/)
  assert.match(src, /depRemoved/, 'removal toasts via moveWithUndo label')
})

/* ---------------- #5 WinControls ---------------- */

test('f6 WinControls: focus-visible has a brand outline replacement gated behind keyboard mode', () => {
  const src = read('components/WinControls.vue')
  assert.match(src, /\.ui-titlebar\[data-focus-mode="key"\] \.ui-btn:focus-visible \{ outline: 1px solid var\(--brand/)
  assert.match(src, /data-focus-mode/, 'keyboard/mouse mode switch exists')
  assert.match(src, /window\.addEventListener\('keydown', this\._onFirstKey, true\)/)
  assert.match(src, /window\.removeEventListener\('keydown', this\._onFirstKey, true\)/, 'cleanup on unmount')
})

/* ---------------- #6/#14 DayRail ---------------- */

test('f6 DayRail: entry card closes on Esc without saving', () => {
  const src = read('components/DayRail.vue')
  const card = src.slice(src.indexOf('class="dr-card"'), src.indexOf('<b>{{ entryDraft.create'))
  assert.match(card, /@keydown\.esc\.stop\.prevent="entryDraft = null"/)
  assert.match(src, /focusCard \(\)/, 'card is focused on open so Esc works immediately')
})

test('f6 DayRail: dead changeLinkedTask method is removed with zero callers', () => {
  const src = read('components/DayRail.vue')
  assert.ok(!/changeLinkedTask \(s, e\)/.test(src), 'method fully removed')
})

/* ---------------- #7/#8/#15/#17 ProjectOverviewView ---------------- */

test('f6 ProjectOverviewView: card no longer nests role=button inside role=link', () => {
  const src = read('views/ProjectOverviewView.vue')
  assert.ok(!/role="link"/.test(src), 'role=link removed from proj-card')
  assert.match(src, /class="proj-card" tabindex="0"/, 'card stays keyboard-openable')
  assert.match(src, /role="button"/, 'status pill remains an independent button')
})

test('f6 ProjectOverviewView: cycleStatus toasts the new status and confirms before "cancelled"', () => {
  const src = read('views/ProjectOverviewView.vue')
  const fn = src.slice(src.indexOf('cycleStatus (id, cur)'), src.indexOf('fmtDate (ts)'))
  assert.match(fn, /\$confirm\(this\.\$t\('projQ\.cancelConfirmText'\)/, 'cancelled requires confirmation')
  assert.match(fn, /\$t\('projQ\.statusChanged'/, 'toast announces the new status')
  assert.match(fn, /next === 'cancelled'/)
})

test('f6 ProjectOverviewView: filtered-empty state differs from no-projects and offers clear-filter', () => {
  const src = read('views/ProjectOverviewView.vue')
  assert.match(src, /\$t\('projQ\.filteredEmpty'\)/)
  assert.match(src, /\$t\('projQ\.clearFilter'\)/)
  assert.match(src, /@click="filter = 'all'"/, 'one-click clear-filter exit')
})

test('f6 ProjectOverviewView: createProject no longer relies on list[list.length-1]', () => {
  const src = read('views/ProjectOverviewView.vue')
  assert.ok(!/list\[list\.length - 1\]/.test(src), 'brittle last-element pick removed')
  assert.match(src, /!before\.has\(c\.categoryId\)/, 'created entity matched by id delta')
  assert.match(src, /c\.categoryName === name/, 'and by exact name')
})

/* ---------------- #16 ProjectView ---------------- */

test('f6 ProjectView: proj-tabs downgraded to a plain button group with aria-pressed', () => {
  const src = read('views/ProjectView.vue')
  assert.ok(!/role="tablist"/.test(src) && !/role="tab"/.test(src), 'unfulfilled tab keyboard contract removed')
  assert.match(src, /:aria-pressed="tab === 'overview'"/)
  assert.match(src, /:aria-pressed="tab === 'docs'"/)
  assert.match(src, /\$t\('statsB\.ProjectView\.tabsAria'\)/, 'group keeps a localized label')
})
