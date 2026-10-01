/**
 * [uiux-2026-10-01 J3 P2] Setting a repeat rule from the edit panel generated the series but the
 * open panel's repeat row still read 设置重复 with no 规则/删除 buttons:
 *  1) RepeatModal.generate created instances carrying repeatId but never stamped the TEMPLATE task
 *     (which IS the series' first instance — effectiveDates excludes its own day), so e.repeatId
 *     stayed null on the task the rule was created from;
 *  2) even after stamping, repeatId was outside FINGERPRINT_FIELDS so the panel's inbound-change
 *     guard classified the update as a non-core own-save echo (verdict 'none') and never
 *     re-hydrated.
 * Run: node --test tests/unit/renderer/uiux-1001-repeat-template-stamp.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('J3 P2: generate stamps the template task with the group repeatId', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.match(src,
    /todo\/updateTodoFields', \{ taskId: tpl\.taskId, patch: \{ repeatId \} \}/,
    'template task must join the repeat group it anchors')
})

test('J3 P2: repeatId is part of the panel fingerprint so the open panel re-hydrates on the stamp', async () => {
  const src = read('renderer/js/utils/editPanelRemoteSync.js')
  assert.match(src, /\['repeatId', 'repeatId'\]/, 'fingerprint vocabulary includes repeatId')
  const mod = await import('file://' + path.join(ROOT, 'renderer/js/utils/editPanelRemoteSync.js').replace(/\\/g, '/'))
  assert.ok(mod.FINGERPRINT_PANEL_KEYS.includes('repeatId'),
    'exported key set (shape-consistency contract) includes repeatId')
})

test('J3 P2: end-to-end verdict — a row stamped with repeatId is "changed" vs a baseline without it', async () => {
  const mod = await import('file://' + path.join(ROOT, 'renderer/js/utils/editPanelRemoteSync.js').replace(/\\/g, '/'))
  const base = { title: 't', desc: '', dateTs: 1000, remindTs: 0, priority: 0, important: 0, categoryId: 0, repeatId: null }
  const baseFingerprint = mod.contentFingerprint(base)
  assert.equal(
    mod.shouldRefreshRemote({ baseFingerprint, baseUpdateTime: 1, row: { title: 't', taskContent: 't', todoTime: 1000, reminderTime: 0, priority: 0, important: 0, categoryId: 0, repeatId: 'repeat_x1', updateTime: 2 } }),
    'changed',
    'panel must classify the template stamp as a material change and re-hydrate')
  assert.equal(
    mod.shouldRefreshRemote({ baseFingerprint, baseUpdateTime: 1, row: { title: 't', taskContent: 't', todoTime: 1000, reminderTime: 0, priority: 0, important: 0, categoryId: 0, repeatId: null, updateTime: 2 } }),
    'none',
    'unrelated updates without a repeatId change stay non-material')
})
