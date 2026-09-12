/**
 * H7 round: Settings/SnManage seam fixes — the side-nav manage modals.
 *   3. countOf excludes recycle-bin rows (must agree with previewOf)
 *   4. the count badge (role=button) activates on Enter/Space, not just click
 *   5. tags modal: keyboard rename prefills tagMgrName and selects the text (same entry as click)
 *   6. categories modal rename focus queries at document level (append-to-body moves the dialog
 *      DOM out of this.$el)
 *
 * Run: node --test tests/unit/components/h7-sn-manage-modals.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const catModal = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
const tagModal = read('renderer/js/components/side-nav/SnManageTagsModal.vue')

test('h7 categories: countOf excludes recycle-bin rows like previewOf', () => {
  assert.match(catModal, /countOf \(id\) \{[\s\S]*?t\.categoryId === id && !t\.complete && !t\.delete/)
  // preview keeps its own filter (regression guard)
  assert.match(catModal, /previewOf \(id\) \{[\s\S]*?!t\.complete && !t\.delete/)
})

test('h7 categories: count badge activates on Enter and Space', () => {
  const badge = catModal.match(/<em class="cat-mgr-count"[\s\S]*?<\/em>/)[0]
  assert.match(badge, /role="button"/)
  assert.match(badge, /@keydown\.enter\.prevent="toggleMgrPreview\(c\.categoryId\)"/)
  assert.match(badge, /@keydown\.space\.prevent="toggleMgrPreview\(c\.categoryId\)"/)
})

test('h7 categories: rename focus queries at document level (append-to-body)', () => {
  const fn = catModal.match(/startMgrEdit \(c\) \{([\s\S]*?)\n\s{4}\},/)[1]
  assert.match(fn, /document\.querySelector/)
  assert.ok(!/\$el\.querySelector/.test(fn), 'this.$el.querySelector misses append-to-body dialog DOM')
  assert.match(fn, /inp\.focus\(\); inp\.select\(\)/)
})

test('h7 tags: keyboard rename prefills and selects via the same entry as click', () => {
  const row = tagModal.match(/<span v-else class="cat-mgr-name"[\s\S]*?<\/span>/)[0]
  assert.match(row, /@click="startTagEdit\(t\)"/)
  assert.match(row, /@keydown\.enter\.prevent="startTagEdit\(t\)"/)
  assert.ok(!/tagMgrEditing=t\.name/.test(row), 'inline flag flip without prefill must be gone')
  const fn = tagModal.match(/startTagEdit \(t\) \{([\s\S]*?)\n\s{4}\},/)[1]
  assert.match(fn, /this\.tagMgrName = t\.name/)
  assert.match(fn, /document\.querySelector\('\.tag-mgr-dialog input\.sn-cat-edit'\)/)
  assert.match(fn, /inp\.focus\(\); inp\.select\(\)/)
  // unique dialog marker so the document-level query cannot hit the categories dialog
  assert.match(tagModal, /class="cat-mgr-dialog tag-mgr-dialog"/)
})
