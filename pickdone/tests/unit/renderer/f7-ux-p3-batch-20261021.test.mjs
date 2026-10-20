/**
 * F7 P3 ux batch (2026-10-21) — regression tests (source-contract style, same seam as the
 * d-wave / f1-f4 series; plus functional tests where the module is importable in plain node).
 *
 * Covered:
 *   F7-1  shared/sanitize-text.mjs: TEXT_MAX_LEN is the single 5000 source; sanitizeMultiline
 *         keeps newlines/blank-line layout while folding horizontal runs; sanitizeText keeps
 *         its pinned wire contract (control/RTL strip, \s\s+ collapse, clamp) byte-stable.
 *   F7-2  EditPanel desc textarea + QuickAdd title input clamp at the SAME shared constant.
 *   F7-3  DayRail: fresh plan chip ids are minted through uniquePlanUid (dedup over loaded
 *         chip ids) at both append/first-drop sites — no bare planUid() in onDrop.
 *   F7-4  DayRail collapsed transition includes width (symmetric collapse/expand animation).
 *   F7-5  QuickAdd failure feedback replays: markFailed resets failed before nextTick-true;
 *         all three failure sites go through it (back-to-back shakes re-trigger).
 *   F7-6  TomatoFocusRecordModal manual record mints a salted mintTomatoId, not genTomatoId.
 *   F7-7  TomatoBar: no hardcoded .2s transitions remain; durations go through --dur-* tokens;
 *         the named "放弃" confirm button stays.
 *   F7-8  store/todo.js removeLocal sets viewsDirty (UNIQUE-loser ghost-row contract).
 *
 * Run: node --test tests/unit/renderer/f7-ux-p3-batch-20261021.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const EDITPANEL = read('renderer/js/components/EditPanel.vue')
const QUICKADD = read('renderer/js/components/QuickAdd.vue')
const DAYRAIL = read('renderer/js/components/DayRail.vue')
const RECORD_MODAL = read('renderer/js/components/TomatoFocusRecordModal.vue')
const TOMATO_BAR = read('renderer/js/components/TomatoBar.vue')
const TODO_STORE = read('renderer/js/store/todo.js')
const { TEXT_MAX_LEN, sanitizeText, sanitizeMultiline } = await import(
  new URL('file:///' + path.join(ROOT, 'shared/sanitize-text.mjs').replace(/\\/g, '/')).href)

/* F7-1: sanitize round-trip contracts */
test('F7-1a: TEXT_MAX_LEN is the shared 5000 ceiling and sanitizeText clamps to it', () => {
  assert.equal(TEXT_MAX_LEN, 5000)
  assert.equal(sanitizeText('x'.repeat(6000)).length, 5000)
  assert.equal(sanitizeMultiline('y'.repeat(6000)).length, 5000)
})

test('F7-1b: sanitizeMultiline preserves newlines/blank lines but folds horizontal runs', () => {
  const para = 'first\n\nsecond   line\t\ttabs\nthird'
  const out = sanitizeMultiline(para)
  assert.equal(out, 'first\n\nsecond line tabs\nthird')
  // CRLF normalizes: \r is a control char and is stripped, \n survives
  assert.equal(sanitizeMultiline('a\r\nb'), 'a\nb')
  // dangerous chars still stripped
  assert.ok(!/[\u202a-\u202e]/.test(sanitizeMultiline('ok\u202aevil')))
})

test('F7-1c: sanitizeText wire contract is byte-stable (newlines still stripped there)', () => {
  // the pinned announce fixture shape (tests/unit/store/tomato-remote-announce.test.mjs):
  // \n and \t are control-range, stripped before the collapse — unchanged from the old pin
  assert.equal(sanitizeText('Line1\nLine2\tTab'), 'Line1Line2Tab')
  assert.equal(sanitizeText('ok\u0000bad'), 'okbad')
})

/* F7-2: renderer inputs clamp at the same-source constant */
test('F7-2: EditPanel desc and QuickAdd title clamp through TEXT_MAX_LEN imports', () => {
  assert.ok(EDITPANEL.includes("import { TEXT_MAX_LEN as DESC_MAX } from '../../../shared/sanitize-text.mjs'"),
    'EditPanel imports the shared ceiling')
  assert.match(EDITPANEL, /:maxlength="DESC_MAX"/, 'desc textarea has the maxlength clamp')
  assert.ok(QUICKADD.includes("import { TEXT_MAX_LEN as TITLE_MAX } from '../../../shared/sanitize-text.mjs'"),
    'QuickAdd imports the shared ceiling')
  assert.match(QUICKADD, /:maxlength="TITLE_MAX"/, 'title input has the maxlength clamp')
})

/* F7-3: plan chip id dedup */
test('F7-3: DayRail mints fresh chip ids through uniquePlanUid at both drop sites', () => {
  assert.match(DAYRAIL, /function uniquePlanUid \(usedIds\) \{[\s\S]*?usedIds\.has\(id\)[\s\S]*?\}/,
    'dedup generator exists and checks the used-id set')
  const drop = DAYRAIL.slice(DAYRAIL.indexOf('    onDrop (h, e) {'))
  assert.ok(!/const id = planUid\(\)/.test(drop), 'onDrop must not mint bare (collidable) ids')
  assert.equal((drop.match(/uniquePlanUid\(usedIds\)/g) || []).length, 2,
    'both the append and first-drop branches use the deduped mint')
  // the used-id set is built from every loaded day's chips
  assert.match(DAYRAIL, /for \(const dayPlansMap of Object\.values\(this\.plans\)\)/)
})

/* F7-4: symmetric collapse animation */
test('F7-4: collapsed day-rail transition keeps the width animation', () => {
  const base = DAYRAIL.match(/\.day-rail \{[^}]*transition: width ([^;]+);/)
  const collapsed = DAYRAIL.match(/\.day-rail\.collapsed \{[^}]*transition: ([^;]+);/)
  assert.ok(base && collapsed, 'both transition rules exist')
  assert.ok(collapsed[1].includes('width ' + base[1].trim().replace(/^width /, '')) ||
    collapsed[1].includes(base[1].trim()),
    'collapsed transition carries the same width timing as the base state')
})

/* F7-5: failure shake replay */
test('F7-5: QuickAdd failure feedback resets-then-retoggles so the shake replays', () => {
  const m = QUICKADD.match(/markFailed \(\) \{([\s\S]*?)\},/)
  assert.ok(m, 'markFailed helper exists')
  assert.match(m[1], /this\.failed = false/, 'resets first…')
  assert.match(m[1], /\$nextTick\(\(\) => \{ this\.failed = true \}\)/, '…then retoggles on the next tick')
  const sites = (QUICKADD.match(/if \(this\.quiet\) this\.markFailed\(\)/g) || []).length
  assert.equal(sites, 3, 'all three failure paths route through markFailed')
  assert.ok(!/this\.failed = true(?!\s*\})/.test(QUICKADD.replace(m[0], '')),
    'no stray direct failed=true assignment outside the helper/reset')
})

/* F7-6: salted tomato id for manual records */
test('F7-6: manual record modal mints a salted mintTomatoId, not the unsalted genTomatoId', () => {
  assert.ok(RECORD_MODAL.includes("import { mintTomatoId } from '../store/tomato.js'"),
    'modal imports the salted mint')
  assert.match(RECORD_MODAL, /tomatoId: mintTomatoId\('tmt_f_', f\.startTs\)/,
    'the addRecord commit uses the salted id (same shape as completeFocus)')
  const script = RECORD_MODAL.slice(RECORD_MODAL.indexOf('<script'))
  assert.ok(!script.includes('genTomatoId()'), 'unsalted generator fully retired from the modal')
})

/* F7-7: duration tokens + kept confirm button */
test('F7-7: TomatoBar transitions are token-driven and the named 放弃 button stays', () => {
  assert.ok(!/transition:[^;]*\.2s(?![,;]*\s*var)/.test(TOMATO_BAR.replace(/var\(--dur-[^)]*\)/g, '')),
    'no hardcoded .2s durations remain outside token fallbacks')
  assert.ok(!/transition: all \.2s/.test(TOMATO_BAR), 'all six all-.2s sites are gone')
  assert.equal((TOMATO_BAR.match(/var\(--dur-fast, \.2s\)/g) || []).length, 6,
    'the six former .2s sites use the --dur-fast token (hover/显隐 tier)')
  assert.match(TOMATO_BAR, /放弃/, 'the confirm dialog keeps its named 放弃 button')
})

/* F7-8: viewsDirty on remove */
test('F7-8: removeLocal marks views dirty (UNIQUE-loser ghost-row contract)', () => {
  const m = TODO_STORE.match(/removeLocal \(s, taskId\) \{([\s\S]*?)\n[ ]{4}\},/)
  assert.ok(m, 'removeLocal mutation found')
  assert.match(m[1], /s\.viewsDirty = true/, 'sets viewsDirty like upsertLocal/hardRemove')
  // and the addTodo UNIQUE-loser path removes through this mutation
  assert.match(TODO_STORE, /UNIQUE constraint failed[\s\S]*?commit\('removeLocal', t\.taskId\)/)
})
