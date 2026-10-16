/**
 * F3 ux-fix batch (2026-10-17) — regression tests, source-contract style (same seam as the
 * d-wave / f1 series; no Vue mount needed).
 *
 * Covered:
 *   F3-1  FeedbackModal: every fb-* control referenced by the template has a definition in the
 *         component's <style> block, and the styles are token-driven (theme-agnostic).
 *   F3-2  TomatoFocusRecordModal: record-row description text no longer hardcodes #666.
 *   F3-3  DayRail: dragOverHour is cleared on dragend AND on Esc (cancel/failure paths), not
 *         only on the successful drop; the Esc listener is also unhooked on unmount.
 *   F3-4  DepView: a loadMilestones rejection sets msError (no fake "no milestone") and the
 *         template offers an explicit error state with a retry affordance (bilingual keys).
 *   F3-5  base.css: the todo tool buttons' combined focus/hover rule no longer zeroes the
 *         keyboard focus ring; a high-specificity :focus-visible ring exists.
 *   F3-6  ProjectView: the 7-day quick-strip trend labels go through the FMT contract, not a
 *         hardcoded 'MM-DD'.
 *   F3-7  TaskAccountModal: the current-year record-row abbreviation uses FMT.cnDate.
 *   F3-8  dateFmtHint examples agree between zh-CN-B and en-US-B (+7d in both).
 *   F3-9  base.css: the RepeatModal label column is adaptive (min-content), not a fixed 44px
 *         that overflows English labels.
 *
 * Run: node --test tests/unit/renderer/f3-ux-fixes-20261017.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const FEEDBACK = read('renderer/js/components/FeedbackModal.vue')
const TOMATO = read('renderer/js/components/TomatoFocusRecordModal.vue')
const DAYRAIL = read('renderer/js/components/DayRail.vue')
const DEPVIEW = read('renderer/js/components/DepView.vue')
const BASE_CSS = read('assets/css/base.css')
const PROJECT = read('renderer/js/views/ProjectView.vue')
const ACCOUNT = read('renderer/js/components/TaskAccountModal.vue')
const ZH_B = read('renderer/js/i18n/locales/zh-CN-B.js')
const EN_B = read('renderer/js/i18n/locales/en-US-B.js')

const styleBlockOf = src => {
  const i = src.lastIndexOf('<style>')
  assert.ok(i >= 0, 'component has a <style> block')
  return src.slice(i)
}

/* F3-1: FeedbackModal form controls are styled */
test('F3-1: every fb-* class referenced by the FeedbackModal template is defined in its style block', () => {
  const tpl = FEEDBACK.slice(0, FEEDBACK.indexOf('<script'))
  const referenced = [...new Set([...tpl.matchAll(/class="([^"]*)"/g)]
    .flatMap(m => m[1].split(/\s+/))
    .filter(c => c.startsWith('fb-')))]
  assert.ok(referenced.length >= 6, 'template references the fb-* family: ' + referenced.join(','))
  const css = styleBlockOf(FEEDBACK)
  for (const c of referenced) {
    assert.ok(css.includes('.' + c), 'style block must define .' + c)
  }
})

test('F3-1: FeedbackModal styles are token-driven (no hardcoded light-only surface/text colors)', () => {
  const css = styleBlockOf(FEEDBACK)
  assert.match(css, /var\(--panel/)
  assert.match(css, /var\(--text-1\)|var\(--text-2\)/)
  assert.match(css, /var\(--brand/)
  // raw hardcoded colors are banned; var(--token, #fallback) literals are the established idiom
  const bare = css.replace(/var\([^)]*\)/g, 'var(...)')
  assert.doesNotMatch(bare, /#(?:fff|ffffff|333|666|909399)\b/i, 'no hardcoded grays/whites that break dark mode')
})

test('F3-1: the template carries no Chinese comments (i18n gate scans template comments)', () => {
  const tpl = FEEDBACK.slice(0, FEEDBACK.indexOf('<script'))
  assert.doesNotMatch(tpl, /<!--[^>]*[\u4e00-\u9fff]/)
})

/* F3-2: TomatoFocusRecordModal description color */
test('F3-2: tomato record description text uses a theme token, not hardcoded #666', () => {
  assert.doesNotMatch(TOMATO, /\.tomato-record__description__text[^}]*#666/)
  assert.match(TOMATO, /\.tomato-record__description__text[^}]*var\(--text-2\)/)
})

/* F3-3: DayRail dragOverHour cleanup on every drag exit path */
test('F3-3: onChipDragEnd clears both _dragPlan and dragOverHour (dragend fires on cancel too)', () => {
  const m = DAYRAIL.match(/onChipDragEnd \(\) \{([^}]*)\}/)
  assert.ok(m, 'onChipDragEnd present')
  assert.match(m[1], /dragOverHour = -1/, 'dragend path must clear the drop highlight')
})

test('F3-3: an Esc keydown clears the stale drop highlight and the listener is removed on unmount', () => {
  assert.match(DAYRAIL, /addEventListener\('keydown', this\._onDragEsc/)
  const handler = DAYRAIL.match(/this\._onDragEsc = e => \{([\s\S]*?)\}\)/)
  assert.ok(handler, 'Esc handler body present')
  assert.match(handler[1], /dragOverHour = -1/)
  assert.match(handler[1], /_dragPlan = null/)
  assert.match(DAYRAIL, /removeEventListener\('keydown', this\._onDragEsc\)/, 'unmount must unhook the document listener')
})

/* F3-4: DepView milestone load failure is surfaced, not disguised */
test('F3-4: loadMilestones catch sets msError instead of faking a clean empty state', () => {
  const catchCall = DEPVIEW.match(/loadMilestones\(pid\)\.then\(([\s\S]*?)catch\(([\s\S]*?)\}\)/)
  assert.ok(catchCall, 'loadMilestones chain present')
  assert.match(catchCall[2], /msError = true/, 'failure must set msError')
  assert.match(DEPVIEW, /this\.msError = false/, 'a fresh loadMs() resets the error flag')
})

test('F3-4: the DepView header renders an explicit error state with a retry affordance', () => {
  assert.match(DEPVIEW, /v-else-if="msError"/)
  assert.match(DEPVIEW, /statsB\.DepView\.msError/)
  assert.match(DEPVIEW, /statsB\.DepView\.msRetry/)
  const retryRow = DEPVIEW.match(/v-else-if="msError"[\s\S]{0,600}?<\/span>/)
  assert.ok(retryRow, 'error branch present in template')
  assert.match(retryRow[0], /@click="loadMs"/, 'retry re-invokes loadMs')
  assert.match(retryRow[0], /role="button"/, 'retry is keyboard-reachable as a button')
})

test('F3-4: msError / msRetry exist in BOTH locale shards', () => {
  assert.match(ZH_B, /msError:\s*'/)
  assert.match(ZH_B, /msRetry:\s*'/)
  assert.match(EN_B, /msError:\s*"/)
  assert.match(EN_B, /msRetry:\s*"/)
})

/* F3-5: base.css keyboard focus ring on todo tool buttons */
test('F3-5: the todo tool button rule no longer zeroes the focus ring and adds a :focus-visible ring', () => {
  assert.doesNotMatch(BASE_CSS, /todo-box-list-item__tools \.btn:focus[^{]*\{[^}]*outline:0/,
    'the combined focus/hover rule must not keep outline:0')
  assert.match(BASE_CSS, /\.todo-list \.todo-box-list-item__tools \.btn:focus-visible\{outline:2px solid var\(--brand\);outline-offset:2px\}/)
})

/* F3-6/F3-7: FMT contract for date labels */
test('F3-6: ProjectView trend labels use FMT.cnDate, not a hardcoded MM-DD', () => {
  const trend = PROJECT.match(/trend7 \(\) \{[\s\S]*?\n    \},/)
  assert.ok(trend, 'trend7 present')
  assert.match(trend[0], /FMT\.cnDate/)
  assert.doesNotMatch(trend[0], /format\('MM-DD'\)/)
})

test('F3-7: TaskAccountModal record-row abbreviation uses FMT.cnDate for the current year', () => {
  const f = ACCOUNT.match(/fmtDate \(r\) \{[\s\S]*?\n    \},/)
  assert.ok(f, 'fmtDate present')
  assert.match(f[0], /FMT\.cnDate/)
  assert.doesNotMatch(f[0], /d\.format\('MM-DD'\)/)
})

/* F3-8: dateFmtHint examples agree across shards */
test('F3-8: dateFmtHint shows the same example day-count in zh and en shards', () => {
  const zh = ZH_B.match(/dateFmtHint: '([^']*)'/)
  const en = EN_B.match(/"dateFmtHint": "([^"]*)"/)
  assert.ok(zh && en, 'both dateFmtHint entries present')
  const days = s => [...s.matchAll(/\+(\d+)d/g)].map(m => m[1]).sort()
  assert.deepEqual(days(zh[1]), days(en[1]), 'example day counts must match: ' + zh[1] + ' vs ' + en[1])
  assert.deepEqual(days(zh[1]), ['7'], 'unified on +7d')
})

/* F3-9: RepeatModal label column adapts */
test('F3-9: .rm-row uses an adaptive label column instead of a fixed 44px', () => {
  const row = BASE_CSS.match(/\.rm-row \{[^}]*\}/)
  assert.ok(row, '.rm-row present')
  assert.match(row[0], /min-content 1fr/)
  assert.doesNotMatch(row[0], /44px/)
})
