/**
 * Project page scroll + milestone rail regression (2026-09-13 incidents).
 *
 * 1. Scroll: the app skeleton pins `.page` at viewport height (overflow:hidden) and gives the
 *    ONLY scrollable region to `.page__main`; ProjectView kept the data-growing `.proj-head`
 *    header and the tab row OUTSIDE that scroller, so the tab body was starved toward 0px and
 *    the header's lower half was clipped — nothing could scroll. Contract: a single
 *    `.page__main.proj-scroll` wraps header + tabs + body.
 * 2. Milestone rails: the strip dots were space-evenly spread while the track above used a
 *    proportional date scale — the two axes visibly disagreed. Contract: one `.proj-ms__main`
 *    column holds track + strip and both read the same `msScale.pos`.
 * 3. Hint copy: the timeline node tooltip claimed "double-click to edit, click to remove" while
 *    nodes edit on single click and have no remove affordance at all.
 *
 * Run: node --test tests/unit/components/projectview-scroll.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = resolveRoot()
function resolveRoot () {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try { readFileSync(join(dir, 'package.json')); return dir } catch { dir = join(dir, '..') }
  }
  throw new Error('repo root not found')
}
const src = readFileSync(join(ROOT, 'renderer/js/views/ProjectView.vue'), 'utf8')
const tpl = src.match(/<template>[\s\S]*<\/template>/)[0]

test('project page: header and tabs live INSIDE the single scroller (whole page scrolls)', () => {
  const scrollerOpen = tpl.indexOf('<div class="page__main proj-scroll">')
  assert.ok(scrollerOpen >= 0, 'scroller .page__main.proj-scroll must exist')
  const headOpen = tpl.indexOf('class="proj-head"')
  const tabsOpen = tpl.indexOf('class="proj-tabs"')
  assert.ok(headOpen > scrollerOpen, '.proj-head must be rendered inside .proj-scroll (it grows with milestones and must stay reachable)')
  assert.ok(tabsOpen > scrollerOpen, '.proj-tabs must be rendered inside .proj-scroll')
  assert.ok(!/v-if="cat" class="proj-head"/.test(tpl.slice(0, scrollerOpen)), 'header must not be hoisted above the scroller again')
})

test('project page: tab bodies are plain .proj-body, never a nested scrollable page__main', () => {
  assert.ok(tpl.includes('class="proj-body proj-body--deps"'), 'deps body')
  const bodies = tpl.match(/class="[^"]*proj-body[^"]*"/g) || []
  assert.ok(bodies.length >= 3, 'overview/docs/deps bodies present')
  for (const b of bodies) assert.ok(!b.includes('page__main'), `body must not nest page__main: ${b}`)
  // overview body kept the legacy flow-top spacing
  assert.match(src, /\.proj-body \{ padding-top: 18px; \}/)
})

test('project page: deps board gets a definite height (depv-cols owns internal scrolling)', () => {
  assert.match(src, /\.proj-body--deps \.depv-wrap \{ height: calc\(100vh - 500px\); min-height: 420px; \}/)
})

test('project page: strip rail shares the timeline column and its exact date->percent scale', () => {
  assert.match(src, /<div class="proj-ms__main">/)
  const mainOpen = src.indexOf('<div class="proj-ms__main">')
  const mainClose = src.indexOf('<button class="proj-ms__add"')
  const trackIdx = src.indexOf('class="proj-ms__track"')
  const stripIdx = src.indexOf('class="proj-ms-strip"')
  assert.ok(mainOpen >= 0 && mainOpen < trackIdx && trackIdx < stripIdx && stripIdx < mainClose,
    'track and strip must both live inside .proj-ms__main')
  assert.match(src, /pct: this\.msScale\.pos\(r\.m\.date\)/, 'strip dot percent must come from msScale.pos')
  assert.match(src, /const pos = this\.msScale\.pos/, 'timeline marks must use the same msScale.pos')
  assert.ok(!/justify-content: space-evenly/.test(src), 'strip must not fall back to even spreading')
})

test('project page: milestone hint copy tells the truth (click edits, removal lives in the card)', () => {
  const zh = readFileSync(join(ROOT, 'renderer/js/i18n/locales/zh-CN-B.js'), 'utf8')
  const en = readFileSync(join(ROOT, 'renderer/js/i18n/locales/en-US-B.js'), 'utf8')
  assert.match(zh, /msEditHint: '（点击编辑；删除在下方卡片）'/)
  assert.match(en, /"msEditHint": " \(click to edit; remove in the card below\)"/)
})
