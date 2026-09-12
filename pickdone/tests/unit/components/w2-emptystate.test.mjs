/**
 * W2 wave: shared EmptyState component replaces the repeated
 * `.empty > .empty__icon + .empty__text` three-line markup across views.
 * Source-level assertions (same paradigm as w1/f6 tests):
 *   - EmptyState.vue renders the exact legacy DOM structure (visual red line)
 *   - all view usages migrated; no hand-written three-line `.empty` blocks remain in views
 *   - base.css has exactly ONE authoritative `.empty` rule (merged padding included)
 *   - i18n keys are carried over verbatim (no new keys)
 *
 * Run: node --test tests/unit/components/w2-emptystate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const emptyVue = read('renderer/js/components/EmptyState.vue')
const baseCss = read('assets/css/base.css')

const MIGRATED_VIEWS = [
  'renderer/js/views/TagView.vue',
  'renderer/js/views/CategoryView.vue',
  'renderer/js/views/StatisticsView.vue',
  'renderer/js/views/FilterView.vue',
  'renderer/js/views/TodoBoxView.vue',
  'renderer/js/views/CompletedView.vue',
  'renderer/js/views/ProjectOverviewView.vue',
  'renderer/js/views/HabitView.vue',
  'renderer/js/views/SearchView.vue',
  'renderer/js/views/ProjectView.vue',
  'renderer/js/views/RecycleBinView.vue'
]

test('w2 EmptyState: renders legacy DOM skeleton (.empty > .empty__icon + .empty__text)', () => {
  assert.match(emptyVue, /<div class="empty" :class="\{ 'empty--inline': inline \}">/)
  assert.match(emptyVue, /<div class="empty__icon">/)
  assert.match(emptyVue, /<div class="empty__text"><slot name="text"\/><\/div>/)
  // no scoped styles — pixel parity comes from base.css alone
  assert.ok(!emptyVue.includes('<style'), 'EmptyState must not carry scoped styles')
})

test('w2 EmptyState: default icon stays empty so the base.css illustration shows', () => {
  // icon prop optional; empty default keeps the icon div byte-identical to legacy markup
  // (v-html with '' adds no child nodes — zero DOM diff, unlike a v-if comment placeholder)
  assert.match(emptyVue, /icon: \{ type: String, default: '' \}/)
  assert.match(emptyVue, /<div class="empty__icon" v-html="icon"><\/div>/)
})

test('w2 EmptyState: inline prop maps to empty--inline modifier; action slot renders after text', () => {
  assert.match(emptyVue, /inline: \{ type: Boolean, default: false \}/)
  const tpl = emptyVue.match(/<template>[\s\S]*<\/template>/)[0]
  const actionIdx = tpl.indexOf('<slot name="action"/>')
  const textIdx = tpl.indexOf('<div class="empty__text">')
  assert.ok(actionIdx > textIdx, 'action slot must come after the text div (legacy ProjectOverview layout)')
})

test('w2 EmptyState: every migrated view uses <empty-state and registers the component', () => {
  for (const view of MIGRATED_VIEWS) {
    const src = read(view)
    assert.match(src, /<empty-state/, `${view} should use <empty-state>`)
    assert.match(src, /import EmptyState from '\.\.\/components\/EmptyState\.vue'/, `${view} should import EmptyState`)
    assert.match(src, /components: \{[^}]*EmptyState/, `${view} should register EmptyState`)
  }
})

test('w2 EmptyState: no hand-written three-line .empty blocks remain in views', () => {
  const viewsDir = path.join(ROOT, 'renderer/js/views')
  const files = readdirSync(viewsDir).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(path.join(viewsDir, f), 'utf8')
    assert.ok(!/class="empty[\s"][^>]*>\s*<div class="empty__icon"/.test(src),
      `${f} still contains a hand-written .empty block`)
  }
})

test('w2 EmptyState: SearchView uses the inline variant; ProjectOverview keeps its clear-filter action', () => {
  assert.match(read('renderer/js/views/SearchView.vue'), /<empty-state[^>]*inline>/)
  const pov = read('renderer/js/views/ProjectOverviewView.vue')
  assert.match(pov, /<template #action>/)
  assert.match(pov, /proj-filter__clear/)
  assert.match(pov, /\$t\('projQ\.filteredEmpty'\)/)
  assert.match(pov, /\$t\('projQ\.clearFilter'\)/)
})

test('w2 EmptyState: base.css has exactly ONE authoritative .empty rule, padding merged in', () => {
  const rules = baseCss.match(/\.empty\s*\{[^}]*\}/g) || []
  assert.equal(rules.length, 1, 'exactly one .empty rule expected, got: ' + rules.join('\n'))
  assert.match(rules[0], /display:flex/)
  assert.match(rules[0], /padding:56px 0 40px/, 'merged padding from the former ~1408 rule')
  // modifier still defined after the base rule
  assert.match(baseCss, /\.empty--inline\{height:auto;padding:40px 20px\}/)
  // pointer comment marks the authoritative location
  assert.match(baseCss, /唯一权威定义/)
})

test('w2 EmptyState: i18n keys carried over verbatim (no new keys introduced)', () => {
  const expected = [
    ['renderer/js/views/TagView.vue', /statsC\.Tag\.empty/],
    ['renderer/js/views/CategoryView.vue', /statsI\.CategoryView\.empty/],
    ['renderer/js/views/StatisticsView.vue', /statsA\.StatisticsView\.emptyState/],
    ['renderer/js/views/FilterView.vue', /statsJ\.FilterView\.notFound/],
    ['renderer/js/views/FilterView.vue', /statsC\.TodoBox\.empty/],
    ['renderer/js/views/TodoBoxView.vue', /statsC\.TodoBox\.empty/],
    ['renderer/js/views/CompletedView.vue', /statsC\.Completed\.empty/],
    ['renderer/js/views/HabitView.vue', /statsB\.HabitView\.empty/],
    ['renderer/js/views/SearchView.vue', /statsC\.Search\.notFound/],
    ['renderer/js/views/SearchView.vue', /statsC\.Search\.empty/],
    ['renderer/js/views/ProjectView.vue', /statsB\.ProjectView\.empty/],
    ['renderer/js/views/RecycleBinView.vue', /statsC\.RecycleBin\.empty/],
    ['renderer/js/views/ProjectOverviewView.vue', /statsB\.ProjectsView\.empty/]
  ]
  for (const [file, re] of expected) assert.match(read(file), re, `${file} lost key ${re}`)
})
