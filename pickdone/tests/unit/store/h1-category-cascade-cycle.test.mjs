/* H1 regression (2026-09-16): with A↔B mutually parented folders (corrupted data / cross-window
 * race), collectCascadeIds's walk and markCascade's mark recursed forever → RangeError and the
 * delete aborted. Both now carry a visited Set to truncate cycles.
 * Run: node --test tests/unit/store/h1-category-cascade-cycle.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import cat, { collectCascadeIds } from '../../../renderer/js/store/category.js'

const mk = (categoryId, folderIs, folderId) => ({ categoryId, userId: 1, categoryName: 'c' + categoryId, categoryColor: '#000', createTime: 0, listSort: 0, folderIs, folderId, delete: false })

test('H1: collectCascadeIds survives an A↔B mutual-parent folder cycle', () => {
  const state = { list: [mk(1, true, 0), mk(2, true, 1), mk(3, false, 2)] }
  // Corrupt: B's folderId points at itself too (self-parent) and a cycle A→B→A
  state.list[1].folderId = 1 // B parented under itself
  state.list[0].folderId = 2 // A parented under B (cycle)
  const ids = collectCascadeIds(state, 1)
  assert.deepEqual([...new Set(ids)], ids, 'no duplicate ids emitted')
  assert.ok(ids.includes(1) && ids.includes(2) && ids.includes(3), 'whole cycle + leaf collected')
})

test('H1: markCascade survives an A↔B mutual-parent cycle and marks every victim', () => {
  const state = { list: [mk(1, true, 0), mk(2, true, 1), mk(3, false, 2), mk(4, false, 1)] }
  state.list[0].folderId = 2 // A parented under B: cycle
  cat.mutations.markCascade(state, 1)
  for (const c of state.list) {
    assert.equal(c.delete, true, 'category ' + c.categoryId + ' marked deleted')
    assert.ok(c.deletedAt, 'deletedAt stamped for ' + c.categoryId)
  }
})

test('H1: normal tree cascade unchanged by the visited guard', () => {
  const state = { list: [mk(1, true, 0), mk(2, true, 1), mk(3, false, 2)] }
  assert.deepEqual(collectCascadeIds(state, 1), [1, 2, 3])
  cat.mutations.markCascade(state, 1)
  assert.equal(state.list.filter(c => c.delete).length, 3)
})
