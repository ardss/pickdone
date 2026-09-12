/**
 * W5 wave: SideNav.vue (hotspot #2) split — the three most independent blocks extracted to
 * components/side-nav/ with zero behavior change:
 *   - SnManageCategoriesModal.vue (mgr* 8 fields + its own mgrDrag* sort state machine)
 *   - SnManageTagsModal.vue       (tagMgr* rename/delete rewrite)
 *   - SnTagPanel.vue              (tag list panel, tags derived from todoList #tags + ui/userTags)
 * Source-level assertions (same paradigm as w1/w2 tests).
 *
 * Run: node --test tests/unit/components/w5-sidenav-split.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const sideNav = read('renderer/js/components/SideNav.vue')
const catModal = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
const tagModal = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
const tagPanel = read('renderer/js/components/side-nav/SnTagPanel.vue')

test('w5 SideNav split: parent registers the three side-nav children', () => {
  assert.match(sideNav, /import SnTagPanel from '\.\/side-nav\/SnTagPanel\.vue'/)
  assert.match(sideNav, /import SnManageCategoriesModal from '\.\/side-nav\/SnManageCategoriesModal\.vue'/)
  assert.match(sideNav, /import SnManageTagsModal from '\.\/side-nav\/SnManageTagsModal\.vue'/)
  assert.match(sideNav, /components: \{ WeatherWidget, SnTagPanel, SnManageCategoriesModal, SnManageTagsModal,/)
})

test('w5 SideNav split: parent delegates to the children via open prop / close emit', () => {
  assert.match(sideNav, /<sn-manage-categories-modal :open="manageVisible" @close="manageVisible=false"\/>/)
  assert.match(sideNav, /<sn-manage-tags-modal :open="tagMgrVisible" @close="tagMgrVisible=false"\/>/)
  assert.match(sideNav, /<sn-tag-panel v-if="showTagPanel"\/>/)
  // dialogs stay mounted (open prop), keeping el-dialog's native open/close transition
  assert.ok(!sideNav.includes('<el-dialog'), 'parent must no longer render any el-dialog directly')
})

test('w5 SnManageCategoriesModal: owns the mgrDrag* sort state machine verbatim', () => {
  for (const name of ['mgrDragId', 'mgrDragOverId', 'mgrDragPos', 'mgrExpanded', 'mgrEditing', 'mgrName']) {
    assert.match(catModal, new RegExp('\\b' + name + '\\b'), name + ' moved with the modal')
    assert.ok(!new RegExp('data \\(\\)[\\s\\S]*?\\b' + name + '\\b').test(sideNav.replace(/\/\/[^\n]*/g, '')),
      name + ' must not remain in the parent data')
  }
  for (const fn of ['dragMgrStart', 'dragMgrOver', 'dropMgrOn', 'startMgrEdit', 'saveMgrEdit', 'previewOf', 'toggleMgrPreview', 'toggleProject', 'removeMgrCat']) {
    assert.match(catModal, new RegExp(fn + ' \\('), fn + ' lives in the modal')
  }
  assert.ok(!/dragMgrStart/.test(sideNav), 'mgr drag handlers must not remain in the parent')
  assert.match(catModal, /emits: \['close'\]/)
  assert.match(catModal, /\$store\.commit\('category\/reorder', ids\)/, 'drag sort still commits category/reorder')
})

test('w5 SnManageCategoriesModal: carries the delete path (confirm + softDelete + detach + settings cleanup)', () => {
  assert.match(catModal, /async delCat \(c\)/)
  assert.match(catModal, /category\/softDelete/)
  assert.match(catModal, /todoBoxCategoryId === c\.categoryId/)
  assert.match(catModal, /isProject \(id\)/)
})

test('w5 SnManageTagsModal: owns tagMgr* rename/delete rewrite verbatim', () => {
  assert.match(tagModal, /tagMgrEditing/, 'tagMgrEditing moved with the modal')
  assert.match(tagModal, /tagMgrName/)
  assert.ok(!/tagMgrEditing/.test(sideNav), 'tagMgrEditing must not remain in the parent')
  for (const fn of ['tagTodos', 'renameTag', 'removeTag']) {
    assert.match(tagModal, new RegExp(fn + ' \\('), fn + ' lives in the tag modal')
    assert.ok(!new RegExp(fn + ' \\(').test(sideNav), fn + ' must not remain in the parent')
  }
  assert.match(tagModal, /emits: \['close'\]/)
  assert.match(tagModal, /updateTodoFields/, 'rename/delete still rewrite task content via dispatch')
})

test('w5 SnTagPanel: multi-root fragment (rows stay direct children of the sn-tags section — zero DOM diff)', () => {
  const tpl = tagPanel.match(/<template>([\s\S]*)<\/template>/)[1]
  assert.ok(!/<div>\s*<div v-for/.test(tpl), 'no wrapper div around the v-for rows')
  assert.match(tpl, /<div v-for="t in tags\.slice\(0,10\)"/)
  assert.match(tpl, /class="sn-cat-item" role="link" tabindex="0"/)
  assert.match(tpl, /<em class="sn-badge">\{\{t\.count\}\}<\/em>/)
})

test('w5 SnTagPanel: derives tags from todoList + ui/userTags and navigates with the same contract as SideNav.go', () => {
  assert.match(tagPanel, /extractTags\(t\.taskContent, t\.taskDescribe\)/)
  assert.match(tagPanel, /this\.\$store\.state\.ui\.userTags/)
  assert.match(tagPanel, /sort\(\(a, b\) => b\.count - a\.count\)/)
  assert.match(tagPanel, /navKeyOfRoute\(name\) \|\| \('category:' \+ \(params && params\.id\)\)/)
})

test('w5 SideNav split: lifecycle side effects stay in the parent (dbCall userTags + _narrowMql cleanup)', () => {
  assert.match(sideNav, /dbCall\('getMeta', 'userTags'\)/)
  assert.match(sideNav, /beforeUnmount \(\)/)
  assert.match(sideNav, /removeEventListener\('change', this\._onNarrow\)/)
  assert.ok(!/dbCall|_narrowMql/.test(tagPanel + catModal + tagModal), 'no lifecycle side effects leaked into children')
})

test('w5 SideNav split: i18n keys stay in their original shards (no key moves or renames)', () => {
  for (const src of [sideNav, catModal, tagModal, tagPanel]) {
    const keys = [...src.matchAll(/\$t\('(stats[A-Z]\.[\w.]+)'/g)].map(m => m[1])
    for (const k of keys) {
      assert.match(k, /^stats[A-Z]\.SideNav\.|^stats[A-Z]\.(core|tipTitle)/, k + ' stays in its original i18n shard')
    }
  }
  // expandSidebar was migrated to statsG by G1 — both usages keep pointing at statsG.SideNav.expandSidebar
  assert.match(sideNav, /statsG\.SideNav\.expandSidebar/)
})

test('w5 SideNav split: cat-mgr styles moved to the modal components; parent keeps the sidebar sn- styles', () => {
  assert.ok(!/\.cat-mgr-row \{/.test(sideNav), 'cat-mgr row rules must not remain in the parent')
  assert.match(catModal, /\.cat-mgr-row--dragging/)
  assert.match(catModal, /\.cat-mgr-row--over-before::before/)
  assert.match(catModal, /\.cat-mgr-del--on/)
  assert.match(catModal, /html\[data-theme="dark"\] \.cat-mgr-row/)
  // tag dialog renders cat-mgr rows on its own and can mount alone, so it carries a copy
  assert.match(tagModal, /\.cat-mgr-row \{/)
  // sidebar's own inline-edit input style stays in the always-mounted parent (global CSS)
  assert.match(sideNav, /\.sn-cat-edit \{/)
})

test('w5 SideNav split: the sidebar category drag state machine (catDrag*) stays in the parent untouched', () => {
  for (const fn of ['catDragId', 'dragOverId', 'trashHot', 'dragStartCat', 'dropOnCat', 'dropOnTrash']) {
    assert.match(sideNav, new RegExp('\\b' + fn + '\\b'), fn + ' remains in the parent')
  }
  assert.match(sideNav, /hierarchical \(\) \{ return this\.\$store\.getters\['category\/hierarchical'\] \}/)
})
