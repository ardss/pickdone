/* F4 regression #1 (2026-09-15): a task's categoryId must fall back to "uncategorized" in views once
 * its category is soft-deleted. The views' name/color lookups all go through the category/byId getter;
 * it used to return soft-deleted rows within the session, so a deleted category's name/color haunted
 * tasks that the EditPanel dropdown (sortedAll) already excluded — contradicting the CLI contract
 * (cli/lib.js deleteCategory: "tasks keep categoryId and fall back to the default (uncategorized) in views").
 * No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: async () => null } }

const mod = await import('../../../renderer/js/store/category.js')
const store = mod.default

function makeState (list) {
  return { list, projectIds: [], projectMeta: {} }
}

test('F4: byId returns null for a soft-deleted category (uncategorized fallback)', () => {
  const state = makeState([
    { categoryId: 1, categoryName: 'Work', categoryColor: '#0f9d8f', delete: false },
    { categoryId: 2, categoryName: 'Gone', categoryColor: '#f76e6e', delete: true }
  ])
  assert.equal(store.getters.byId(state)(2), null, 'deleted category must not answer byId')
  assert.equal(store.getters.byId(state)(1)?.categoryName, 'Work', 'live category still resolves')
  assert.equal(store.getters.byId(state)(999), null, 'missing id still resolves to null')
})

test('F4: byId answers again after the category is restored (delete flag cleared)', () => {
  const state = makeState([{ categoryId: 2, categoryName: 'Gone', categoryColor: '#f76e6e', delete: false }])
  assert.equal(store.getters.byId(state)(2)?.categoryName, 'Gone')
})
