/**
 * Domain-2 P3 refactor (#132 skipped P3-11 continuation): EditPanel.vue's pomodoro estimate/actual
 * ledger row and hash-tag row extracted to edit-panel/EpTomato.vue / EpTags.vue — pure move, zero
 * behavior change. The input buffer + IME guard for tags live in the child; the title rewrite
 * (addTag/removeTag), persistence pipeline, estDelta/openAccount and the data sources stay in the
 * host. edit-panel/EpReminders.vue (domain-3) is NOT touched.
 * Run: node --test tests/unit/components/dw2-editpanel-ep-tomato-tags.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const parent = read('renderer/js/components/EditPanel.vue')
const tomato = read('renderer/js/components/edit-panel/EpTomato.vue')
const tags = read('renderer/js/components/edit-panel/EpTags.vue')

test('EditPanel: ledger row delegated to <ep-tomato>, markup moved verbatim', () => {
  assert.match(parent, /<ep-tomato :estimate="tomatoEstimateN" :actual="tomatoActual" @est-delta="estDelta" @open="openAccount"\/>/)
  // the row markup left the host template (now single-sourced in the child)
  assert.ok(!parent.includes('class="ep-row ep-tomato-est"'), 'ledger row markup lives in the child')
  assert.match(tomato, /class="ep-row ep-tomato-est"/)
  for (const cls of ['ep-tom-account', 'ep-tom-seg--est', 'ep-tom-seg--act', 'ep-tom-step', 'ep-tom-num', 'ep-tom-ico']) {
    assert.match(tomato, new RegExp(cls))
  }
  // domain-3 boundary: EpReminders stays untouched and imported from its owner path
  assert.match(parent, /import EpReminders from '\.\/edit-panel\/EpReminders\.vue'/)
  assert.ok(!read('renderer/js/components/edit-panel/EpReminders.vue').includes('EpTomato'), 'EpReminders (domain-3) untouched')
})

test('EditPanel: ledger state + persistence stay in the host', () => {
  for (const anchor of ['tomatoEstimateN () { ensureEstimate', 'getEstimate(this.e && this.e.taskId)', "actualCountByTask", 'estDelta (d) { setEstimate(', 'openAccount () {']) {
    assert.match(parent, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), anchor)
  }
  assert.ok(!tomato.includes('setEstimate') && !tomato.includes('ensureEstimate'), 'child is presentational')
})

test('EditPanel: tag row delegated to <ep-tags>; input buffer + IME guard moved with it', () => {
  assert.match(parent, /<ep-tags :tags="taskTags" @add="addTag" @remove="removeTag"\/>/)
  // the input node + buffer left the host (its global CSS rules legitimately remain)
  const parentBody = parent.replace(/<style>[\s\S]*<\/style>/, '')
  assert.ok(!parentBody.includes('ep-tag-input') && !parentBody.includes('tagInput'), 'input buffer lives in the child now')
  assert.match(tags, /class="ep-tag-input"/)
  assert.match(tags, /v-model="tagInput"/)
  // the IME guard (composition Enter, keyCode 229) moved with the input
  assert.match(tags, /e\.isComposing \|\| e\.keyCode === 229/)
  assert.ok(tags.includes("replace(/^#+/, '')"), 'hash-prefix stripping moved with the input')
  assert.match(tags, /this\.tags\.includes\(name\)/, 'dedup against the derived tag list stays in the child')
  assert.ok(!parent.includes('keyCode === 229'), 'parent no longer owns the tag IME guard')
})

test('EditPanel: title rewrite (addTag/removeTag) stays in the host with the persistence pipeline', () => {
  assert.match(parent, /addTag \(name\) \{/)
  assert.match(parent, /base \+ ' #' \+ name/, 'append semantics unchanged')
  assert.match(parent, /removeTag \(name\) \{/)
  assert.match(parent, /removeWithUndo/, 'undoable removal unchanged')
  assert.match(tags, /\$emit\('add', name\)/)
  assert.match(tags, /\$emit\('remove', t\)/)
  assert.ok(!tags.includes('fieldPatch') && !tags.includes('queueSave'), 'child never persists directly')
})

test('EditPanel line budget: host shrank below its pre-split 1030 lines (structure-baseline re-registration pending in domain-4)', () => {
  const lines = parent.split('\n').length
  assert.ok(lines < 1030, `EditPanel.vue now ${lines} lines (< 1030 pre-split)`)
  assert.ok(existsSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpTomato.vue')))
  assert.ok(existsSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpTags.vue')))
})
