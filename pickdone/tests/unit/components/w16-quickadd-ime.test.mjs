/**
 * W16 P1 regression (2026-10-28) — QuickAdd Enter/Esc IME guard must listen on keydown.
 *
 * Bug: the guards lived on @keyup.enter / @keyup.esc, but in Chromium an IME Enter is
 * keydown(229) -> compositionend (v-model already synced the committed text) -> keyup
 * (isComposing already false). The keyup handler therefore saw isComposing=false, keyCode=13
 * and onEnter() created a task out of the text that had just landed on screen. The repo
 * already acknowledged this on the same page: SideNav.vue onCatEditEnter and EpSubtasks.vue
 * listen on keydown for exactly this reason.
 *
 * Fix: QuickAdd binds @keydown.enter (inline guard kept) and @keydown.esc (onCancel keeps its
 * own composing guard, same semantics).
 * Run: node --test tests/unit/components/w16-quickadd-ime.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/QuickAdd.vue'), 'utf8')
const template = src.match(/<template>[\s\S]*<\/template>/)[0]

test('W16: Enter submit binds keydown (not keyup) with the composing/229 inline guard kept', () => {
  assert.ok(/@keydown\.enter="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; onEnter\(\) \}"/.test(template),
    'input must bind @keydown.enter with the isComposing/229 guard inline')
  assert.ok(!/@keyup\.enter/.test(template),
    '@keyup.enter must be gone: keyup cannot see the composition flag after compositionend')
})

test('W16: Esc cancel binds keydown too (same keyup blindness); onCancel keeps its guard', () => {
  assert.ok(/@keydown\.esc="onCancel"/.test(template), 'Esc must be handled on keydown')
  assert.ok(!/@keyup\.esc/.test(template), '@keyup.esc must be gone')
  assert.ok(/onCancel \(e\) \{[\s\S]*?e\.isComposing \|\| e\.keyCode === 229/.test(src),
    'onCancel must keep its own IME guard (composition-committing Esc must not wipe the draft)')
})
