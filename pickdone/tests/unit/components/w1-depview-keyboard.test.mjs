/**
 * W1 wave: DepView dependency canvas - complete keyboard scheme (connect mode).
 * Regression tests (source-level assertion paradigm, same as f6-fixes.test.mjs):
 *   - connect mode entry (`c` / Ctrl+Enter), Enter confirms, Esc cancels, Tab/arrows move target
 *   - Enter-confirmation reuses addDependency (the SAME write path as mouse drag-drop onDrop,
 *     including cycle rejection) - no duplicated logic
 *   - previous plain-Enter = openEdit behavior preserved; mouse path untouched
 *   - aria-live status line for connect mode; keyboard context menu (Shift+F10) reachable
 *   - i18n bilingual parity for the new connectHint key
 *
 * Run: node --test tests/unit/components/w1-depview-keyboard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const depVue = readFileSync(path.join(ROOT, 'renderer/js/components/DepView.vue'), 'utf8')

/* ---------------- connect mode entry ---------------- */

test('w1 DepView: card keydown is routed through a single handler (no bare enter=openEdit binding)', () => {
  assert.match(depVue, /@keydown="onCardKeydown\(t, \$event\)"/)
  assert.ok(!depVue.includes('@keydown.enter.prevent="openEdit(t)"'),
    'plain Enter must be handled inside onCardKeydown so connect mode can claim it')
})

test('w1 DepView: connect mode entered via `c` or Ctrl/Cmd+Enter; plain Enter still opens edit', () => {
  const fn = depVue.match(/onCardKeydown \(t, e\) \{[\s\S]*?\n {4}\},/)[0]
  // entry keys
  assert.match(fn, /e\.key === 'c' \|\| e\.key === 'C'/)
  assert.match(fn, /e\.ctrlKey \|\| e\.metaKey\) this\.startConnect\(t\)/)
  assert.match(fn, /this\.startConnect\(t\)/)
  // preserved behavior: non-connect plain Enter -> openEdit
  assert.match(fn, /else this\.openEdit\(t\)/)
})

test('w1 DepView: in connect mode Enter confirms / Tab+arrows move target / Esc cancels', () => {
  const fn = depVue.match(/onCardKeydown \(t, e\) \{[\s\S]*?\n {4}\},/)[0]
  const connectBranch = fn.slice(0, fn.indexOf("if (this.connectSrc)") + 900)
  assert.match(fn, /k === 'Escape'\) \{ e\.preventDefault\(\); this\.cancelConnect\(\)/)
  assert.match(fn, /k === 'Tab'\) \{ e\.preventDefault\(\); this\.moveConnectTarget\(e\.shiftKey \? -1 : 1\)/)
  assert.match(fn, /k === 'ArrowRight' \|\| k === 'ArrowDown'/)
  assert.match(fn, /k === 'ArrowLeft' \|\| k === 'ArrowUp'/)
  assert.match(fn, /k === 'Enter'\) \{ e\.preventDefault\(\); this\.confirmConnect\(\)/)
  assert.ok(connectBranch.length > 0)
})

/* ---------------- reuse of the drag-drop write path (incl. cycle rejection) ---------------- */

test('w1 DepView: confirmConnect reuses addDependency - the same method onDrop calls', () => {
  const confirm = depVue.match(/confirmConnect \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(confirm, /this\.addDependency\(tg, src\.taskId, src, tg\)/,
    'keyboard confirm must reuse addDependency, not duplicate the write logic')
  // addDependency itself carries the cycle check and is shared with onDrop
  const add = depVue.match(/addDependency \(target, prereqId, prereqTask, dependentTask\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(add, /cycleErr/, 'cycle rejection lives inside the shared addDependency')
  assert.match(depVue, /side === 'right'\) this\.addDependency/, 'mouse drop path unchanged')
  assert.match(depVue, /else this\.addDependency/, 'mouse drop path unchanged (left half)')
})

test('w1 DepView: Esc can always exit - card handler + wrap-level fallback + cancel resets state', () => {
  assert.match(depVue, /@keydown\.esc="cancelConnect"/, 'wrap-level Esc fallback')
  const cancel = depVue.match(/cancelConnect \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(cancel, /this\.connectSrc = ''/)
  assert.match(cancel, /this\.connectTargetIdx = 0/)
})

test('w1 DepView: mouse paths not broken - click still opens edit outside connect mode', () => {
  const click = depVue.match(/onCardClick \(t\) \{[^\n]*\}/)[0]
  assert.match(click, /this\.cancelConnect\(\); return/)
  assert.match(click, /this\.openEdit\(t\)/)
})

/* ---------------- visual state + accessibility ---------------- */

test('w1 DepView: connect mode highlights source and target via dedicated classes', () => {
  assert.match(depVue, /'depv-task--connect-src': connectSrc === t\.taskId/)
  assert.match(depVue, /'depv-task--connect-target': !!connectSrc && connectSrc !== t\.taskId && connectTargetId === t\.taskId/)
  assert.match(depVue, /\.depv-task--connect-src \{/)
  assert.match(depVue, /\.depv-task--connect-target \{/)
})

test('w1 DepView: connect mode hint is announced (role=status + aria-live=polite) and v-if gated', () => {
  const hint = depVue.match(/<div v-if="connectSrc" class="depv-connect"[\s\S]*?<\/div>/)[0]
  assert.match(hint, /role="status"/)
  assert.match(hint, /aria-live="polite"/)
  assert.match(hint, /\$t\('statsA\.DepView\.connectHint'/)
})

test('w1 DepView: connect-mode target navigation wraps and never targets the source itself', () => {
  const move = depVue.match(/moveConnectTarget \(delta\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(move, /% n/, 'index math must wrap')
  const targets = depVue.match(/connectTargets \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(targets, /t\.taskId !== this\.connectSrc/, 'source card excluded from targets')
  const id = depVue.match(/connectTargetId \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(id, /% tg\.length/, 'target id lookup is bounds-safe')
})

test('w1 DepView: keyboard context menu (Shift+F10) reaches the same taskContextMenu with remove-dep extras', () => {
  const fn = depVue.match(/onCardKeydown \(t, e\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(fn, /e\.key === 'F10' && e\.shiftKey/)
  assert.match(fn, /this\.taskContextMenu\(t, e\)/)
  assert.match(depVue, /@contextmenu="taskContextMenu\(t, \$event\)"/, 'mouse contextmenu binding intact')
  assert.match(depVue, /removeDep/, 'remove-prerequisite menu entries still wired')
})

test('w1 DepView: connect mode auto-cancels when the source card leaves the scope', () => {
  assert.match(depVue, /this\.connectSrc && !this\.inScope\.some\(x => x\.taskId === this\.connectSrc\)\) this\.cancelConnect\(\)/)
})

/* ---------------- i18n bilingual parity ---------------- */

test('w1 i18n: connectHint exists in both languages with the {a} placeholder', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  const enA = await load('en-US-A.js')
  const zhA = await load('zh-CN-A.js')
  assert.ok(enA.statsA.DepView.connectHint, 'en-US connectHint')
  assert.ok(zhA.statsA.DepView.connectHint, 'zh-CN connectHint')
  assert.match(enA.statsA.DepView.connectHint, /\{a\}/)
  assert.match(zhA.statsA.DepView.connectHint, /\{a\}/)
})

test('w1 i18n: zh-CN-A and en-US-A shards keep full flattened key parity', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, `${pre}${k}.`) : [`${pre}${k}`]).sort()
  const e = flat(await load('en-US-A.js'))
  const z = flat(await load('zh-CN-A.js'))
  assert.deepEqual(e, z)
})
