/**
 * Domain-2 P2 refactor: SideNav.vue's category rows were three near-verbatim template copies
 * (folder / child / flat, each with its own inline sn-cat-edit input and rename/del icon pair,
 * `sn-cat-edit` appearing 7×) and the foot action trio (sync/recycle/settings) was duplicated
 * across the expanded sn-account row and the collapsed sn-collapsed-foot. Extracted to
 * side-nav/SnCategoryItem.vue (one row, three variants via props) and side-nav/SnFootActions.vue
 * (collapsed prop). Zero behavior change: all state + handlers stay in the parent.
 * Source-level assertions (same paradigm as w5-sidenav-split.test.mjs).
 *
 * Run: node --test tests/unit/components/dw2-sidenav-rows-split.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const sideNav = read('renderer/js/components/SideNav.vue')
const row = read('renderer/js/components/side-nav/SnCategoryItem.vue')
const foot = read('renderer/js/components/side-nav/SnFootActions.vue')
// strip the parent's style block: markup claims must be about the template/script
const sideNavBody = sideNav.replace(/<style>[\s\S]*<\/style>/, '')

test('SideNav: the three category-row copies are replaced by one SnCategoryItem usage set', () => {
  assert.match(sideNav, /import SnCategoryItem from '\.\/side-nav\/SnCategoryItem\.vue'/)
  assert.match(sideNav, /components: \{[^}]*SnCategoryItem[^}]*\}/)
  // the three variants are delegated via props, not by three inline copies
  assert.match(sideNavBody, /variant="folder"/)
  assert.match(sideNavBody, /variant="child"/)
  assert.match(sideNavBody, /variant="flat"/)
  // the inline rename input node moved with the child (the parent's querySelector('.sn-cat-edit')
  // focus helper in createCategory/startCatEdit legitimately stays — the node is still inside its $el)
  assert.ok(!sideNavBody.includes('class="sn-cat-edit"'), 'inline sn-cat-edit input node must live in the child now')
  assert.match(row, /class="sn-cat-edit"/)
  // row chrome moved with the child too
  for (const marker of ['sn-cat-folder', 'sn-cat-child', 'folder-toggle-icon', 'sn-cat-ren', 'dblclickRenameTip']) {
    assert.ok(!sideNavBody.includes(marker), marker + ' must not remain in the parent template')
    assert.ok(row.includes(marker), marker + ' lives in the child')
  }
})

test('SideNav: behavior parity — every row mutation still resolves in the parent', () => {
  for (const fn of ['toggleFolder', 'startCatEdit', 'delCat', 'onCatEditEnter', 'cancelCatEdit', 'saveCatEdit', 'dragStartCat', 'dragOverCat', 'dropOnCat', 'dragEndCat']) {
    assert.match(sideNav, new RegExp(fn + ' \\('), fn + ' stays in the parent')
  }
  // the rename buffer stays parent-owned (createCategory pre-seeds it; saveCatEdit guards by catEditing)
  assert.match(sideNavBody, /@edit-input="newCatName=\$event"/)
  assert.match(sideNavBody, /@edit-enter="onCatEditEnter\(\$event, /)
  assert.match(sideNavBody, /@edit-save="saveCatEdit\(/)
})

test('SideNav: the foot action trio is one SnFootActions (expanded + collapsed usages)', () => {
  assert.match(sideNav, /import SnFootActions from '\.\/side-nav\/SnFootActions\.vue'/)
  assert.match(sideNavBody, /<sn-foot-actions :spinning="spinning"/)
  assert.match(sideNavBody, /<sn-foot-actions collapsed/)
  // the duplicated markup moved to the child: no sync check-SVG, no collapsed-foot container, no
  // account-gear buttons left in the parent body
  for (const marker of ['sn-sync--done', 'sn-collapsed-foot', 'sn-account-trash', 'sn-account-gear', 'sn-cog-btn']) {
    assert.ok(!sideNavBody.includes(marker), marker + ' must not remain in the parent body')
  }
  assert.match(foot, /class="sn-account-gear sn-account-trash"/)
  assert.match(foot, /class="sn-collapsed-foot"/)
  assert.match(foot, /sn-cog-btn/g)
})

test('SnFootActions: behavior parity — sync/recycle/settings handlers and trash drop target stay in the parent', () => {
  for (const fn of ['syncNow', 'openSettings', 'trashDragOver', 'dropOnTrash']) {
    assert.match(sideNav, new RegExp(fn + ' \\('), fn + ' stays in the parent')
  }
  assert.match(sideNavBody, /@sync="syncNow" @recycle="go\('todo-list-recycle-bin'\)" @settings="openSettings"/)
  assert.match(sideNavBody, /@trash-dragover="trashDragOver" @trash-dragleave="trashHot=false" @trash-drop="dropOnTrash"/)
  // child keeps the exact interactive surface: enter-activation, dragover/drop bindings, badge, update dot
  assert.match(foot, /@keydown\.enter\.prevent="\$emit\('sync'\)"/)
  assert.match(foot, /\$emit\('trash-dragover', \$event\)/)
  assert.match(foot, /v-if="recycleCount" class="sn-badge"/)
  assert.match(foot, /v-if="updateReady" class="sn-upd-dot"/)
})
