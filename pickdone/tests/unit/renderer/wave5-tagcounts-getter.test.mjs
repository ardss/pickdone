/**
 * Wave-5 P2 (refactor, behavior-preserving): the tag count aggregation (iterate todoList with
 * extractTags, backfill empty ui/userTags placeholders with count 0, sort count-desc) was kept
 * VERBATIM in three components — SideNav.vue, SnTagPanel.vue, SnManageTagsModal.vue (their own
 * comments admitted being copies). Single source now: getters['todo/tagCounts'] in store/todo.js
 * (pure derivation from state; Vuex caching comes for free).
 * Run: node --test tests/unit/renderer/wave5-tagcounts-getter.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')

test('todo/tagCounts counts #tags across todoList, backfills empty userTags, sorts count-desc', async () => {
  const { default: todoModule } = await import('../../../renderer/js/store/todo.js')
  const state = { todoList: [
    { taskContent: '#a #b hello', taskDescribe: '' },
    { taskContent: '#a again', taskDescribe: '#b' },
    { taskContent: 'no tags', taskDescribe: '' }
  ] }
  const rootState = { ui: { userTags: ['c', 'a'] } } // 'c' is a New-Tag placeholder -> count 0; 'a' already counted
  const tags = todoModule.getters.tagCounts(state, {}, rootState)
  assert.deepEqual(tags, [
    { name: 'a', count: 2 },
    { name: 'b', count: 2 },
    { name: 'c', count: 0 }
  ], 'shape identical to the three removed copies: count-desc, placeholder count 0, tie order stable by first sight')
})

test('source anchors: the three components read the single getter, the counting loops are gone', () => {
  const read = p => readFileSync(path.join(ROOT, p), 'utf8')
  const sideNav = read('renderer/js/components/SideNav.vue')
  const panel = read('renderer/js/components/side-nav/SnTagPanel.vue')
  const modal = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  for (const [name, src] of [['SideNav', sideNav], ['SnTagPanel', panel], ['SnManageTagsModal', modal]]) {
    assert.match(src, /getters\['todo\/tagCounts'\]/, name + ' reads the single getter')
    assert.ok(!/set\.set\(tag/.test(src), name + ' no longer carries the counting loop (SideNav createTag keeps its own legitimate ui.userTags dedup)')
  }
  const store = read('renderer/js/store/todo.js')
  assert.match(store, /tagCounts: \(s, _g, rootState\)/)
  // SnManageTagsModal still needs extractTags for its rename/delete tagTodos counting
  assert.match(modal, /extractTags\(t\.taskContent, t\.taskDescribe\)/)
})
