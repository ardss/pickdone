/**
 * Domain-2 P3 fixes (dialogA11y follow-ups):
 *  - FeedbackModal was the only one of the 10 dialogA11y dialogs without a root @keydown.esc
 *    fallback: focus inside its desc textarea / contact input makes the mixin defer to native
 *    Escape behavior (dialogA11y.onKeydown returns for INPUT/TEXTAREA), so Esc did nothing.
 *  - The mixin's header comment claimed callers must listen for a 'dialogEscape' event — no such
 *    event is ever emitted or listened to anywhere; the real contract is close()/onCancel/$emit('close').
 *  - The six `?` hint marks (span.hint-q) carried only :title — first made focusable
 *    (role=button), then demoted to role=img + aria-label by the maint/dw F-D4 round: a button
 *    with zero activation logic is a lie to screen readers, image semantics + accessible name
 *    is the honest shape.
 * Run: node --test tests/unit/renderer/dw2-dialog-a11y-followups.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO = path.resolve(ROOT, '..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const C = 'renderer/js/components'

test('FeedbackModal: .modal root carries @keydown.esc="close" like the other 9 mixin dialogs', () => {
  const src = read(`${C}/FeedbackModal.vue`)
  assert.match(src, /<div class="modal" role="dialog" aria-modal="true"[^>]*@keydown\.esc="close"/)
  assert.match(src, /mixins: \[dialogA11y\]/)
  // survey: every component using the mixin now has an esc listener on its root node
  const users = []
  for (const dir of [C, `${C}/side-nav`]) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.vue'))) {
      const s = read(`${dir}/${f}`)
      if (s.includes('dialogA11y')) users.push(`${dir}/${f}`)
    }
  }
  assert.ok(users.length >= 10, 'the 10 known mixin dialogs are all still mixin users')
  for (const f of users) assert.match(read(f), /@keydown\.esc/, `${f} roots an @keydown.esc fallback`)
})

test("dialogA11y: header comment states the real Escape contract; no 'dialogEscape' channel exists", () => {
  const src = read('renderer/js/utils/dialogA11y.js')
  assert.match(src, /if \(typeof this\.close === 'function'\)/)
  assert.match(src, /else if \(typeof this\.onCancel === 'function'\)/)
  assert.match(src, /else this\.\$emit\('close'\)/)
  assert.match(src, /Escape contract/, 'header documents the actual contract')
  assert.ok(!src.includes('dialogEscape'), 'the dead dialogEscape channel is gone from the mixin')
  // repo-wide: zero emits / zero listeners under renderer/ (tracked files, working tree)
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-l', 'dialogEscape', '--', 'pickdone/renderer'], { cwd: REPO, encoding: 'utf8' }).trim()
  } catch (e) {
    // git grep exits 1 on zero matches — that is the pass condition
    if (e.status !== 1) throw e
  }
  assert.equal(out, '', 'dialogEscape must not appear anywhere under pickdone/renderer/')
})

test('hint-q: all six ? marks carry an accessible name and NO fake-button semantics (role=img, F-D4 demotion)', () => {
  // EpTomato.vue hosts the ledger-row hint since the domain-2 EditPanel split.
  // maint/dw wave (2026-09-24) F-D4: the marks were demoted from role=button (zero click/keydown
  // handlers — Space hit the global role activator calling .click() into the void) to honest
  // role=img + aria-label; this assertion was updated by the demoting round to pin the new shape.
  const files = [`${C}/EditPanel.vue`, `${C}/edit-panel/EpTomato.vue`, `${C}/RepeatModal.vue`]
  let seen = 0
  for (const f of files) {
    const src = read(f)
    const spans = src.match(/<span class="hint-q"[^>]*><\/span>/g) || src.match(/<span class="hint-q"[^>]*>\?<\/span>/g) || []
    assert.ok(spans.length > 0, `${f} still renders its hint-q marks`)
    for (const span of spans) {
      assert.match(span, /role="img"/, 'demoted to honest image semantics')
      assert.doesNotMatch(span, /role="button"/, 'the dead button role must not come back')
      assert.doesNotMatch(span, /tabindex/, 'no fake tab stop without activation')
      assert.match(span, /:aria-label="\$t\('[^']+'\)"/, 'aria-label bound to the same i18n key as title')
      seen++
    }
  }
  assert.equal(seen, 6, 'exactly the six known hint-q marks (2 in EditPanel + 4 in RepeatModal)')
})

test('hint-q: :focus-visible style present in both host style blocks (no base.css exists)', () => {
  for (const f of [`${C}/EditPanel.vue`, `${C}/RepeatModal.vue`]) {
    const src = read(f)
    assert.match(src, /\.hint-q:focus-visible\s*\{[^}]*outline/, `${f} style block carries the focus ring`)
  }
})
