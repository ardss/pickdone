/**
 * [uiux-2026-10-01 J1 P3] Esc in the top quick-add box neither cleared the draft nor blurred the
 * field — only @keyup.enter was bound. Esc is the universal cancel key: it now clears the draft
 * and blurs. Source-anchor lock (the behavior itself is a one-line template binding; mounting the
 * SFC in Node is out of scope for the unit harness).
 * Run: node --test tests/unit/renderer/uiux-1001-quickadd-esc.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('J1 P3: quick-add input binds Esc to a cancel handler that clears and blurs', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /@keyup\.esc="onCancel"/, 'Esc binding on the qa input (event passed implicitly)')
  // maint/d23: Esc now also carries the IME guard — dismissing a candidate window fires keyup
  // mid-composition and must not wipe the draft (same contract as the Enter binding).
  assert.match(src, /onCancel \(e\) \{[\s\S]*?if \(e && \(e\.isComposing \|\| e\.keyCode === 229\)\) return/,
    'IME composition guard at the top of onCancel')
  assert.match(src, /onCancel \(e\) \{[\s\S]*?this\.text = ''/, 'clears the draft')
  assert.match(src, /onCancel \(e\) \{[\s\S]*?inp\.blur\(\)/, 'blurs the field')
})
