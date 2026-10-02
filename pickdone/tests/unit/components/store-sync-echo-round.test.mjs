/**
 * Store↔sync pipeline regression batch (P1 2026-10-01 round).
 *
 * Root causes covered here:
 *  1. contentFingerprint mapped a missing priority/important to '' while the panel snapshot
 *     defaults undefined→0 — browser-shim rows (and any row predating the db normalization)
 *     made every own-save echo classify as a peer edit, so the pristine re-hydrate branch
 *     fired and discarded mid-panel edits (J3 subtask vanish).
 *  2. EditPanel.hydrate rebuilt from the open-time ui.rightSidebarTodoEdit snapshot instead
 *     of the live store row — everything added since open was silently dropped on every
 *     pristine re-hydrate and the stale copy was written back over the store (J2 stale title).
 *  3. The auto-close guard trusted a transient null of the `task` computed during a full
 *     reload — picking a deadline in that window slammed the panel shut and lost the edit.
 *
 * EditPanel.vue is an SFC (not importable from node:test), so its two policy changes are
 * anchored by source-shape assertions plus behavioral tests of the extracted helpers they
 * call (buildEditSnapshot / taskAbsentIn), mirroring the d1-editpanel-knives convention.
 *
 * Run: node --test tests/unit/components/store-sync-echo-round.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const EPS = await import('../../../renderer/js/utils/editPanelRemoteSync.js')
const UIMOD = await import('../../../renderer/js/store/ui.js')
const UI = UIMOD.default
const { buildEditSnapshot } = UIMOD

const { contentFingerprint, shouldRefreshRemote, taskAbsentIn } = EPS

/* ---- 1. Fingerprint normalization: own-save echo must not read as a peer edit ---- */

test('fingerprint: row lacking priority/important matches the snapshot-defaulted panel copy', () => {
  const panelSnap = buildEditSnapshot({
    taskId: 't1', taskContent: 'A', taskDescribe: '', todoTime: 0, reminderTime: 0, categoryId: 0
  }) // openEdit defaults priority/important to 0
  const echoedRow = { // the same row after the panel's own save (updateTime bumped, priority absent)
    taskId: 't1', taskContent: 'A', taskDescribe: '', todoTime: 0, reminderTime: 0,
    categoryId: 0, updateTime: panelSnap.updateTime + 1
  }
  assert.equal(contentFingerprint(panelSnap), contentFingerprint(echoedRow),
    'missing numeric fields fingerprint to the same default the snapshot applies (0), not ""')
  assert.equal(shouldRefreshRemote({ baseFingerprint: contentFingerprint(panelSnap), baseUpdateTime: panelSnap.updateTime, row: echoedRow }),
    'none', 'own-save echo with bumped updateTime but identical content is NOT a peer edit')
})

test('fingerprint: a real peer edit still classifies as changed', () => {
  const base = { taskId: 't1', taskContent: 'A', taskDescribe: '', todoTime: 0, reminderTime: 0, categoryId: 0, priority: 0, important: 0, updateTime: 100 }
  const peer = { ...base, taskContent: 'B', updateTime: 200 }
  assert.equal(shouldRefreshRemote({ baseFingerprint: contentFingerprint(base), baseUpdateTime: 100, row: peer }), 'changed')
})

/* ---- 2. buildEditSnapshot: shared single-source snapshot builder ---- */

test('buildEditSnapshot maps raw-row vocabulary to panel vocabulary and parses JSON lists', () => {
  const snap = buildEditSnapshot({
    taskId: 't1',
    taskContent: 'hello',
    taskDescribe: 'd',
    todoTime: 12345,
    reminderTime: 999,
    reminderOffsets: [1, 2],
    reminderExtra: [3],
    categoryId: 7,
    repeatId: 'r1',
    deadlineTs: 555,
    priority: 3,
    important: 1,
    subtasks: JSON.stringify([{ text: 's1', checked: false }]),
    image: JSON.stringify([{ url: 'u' }]),
    files: JSON.stringify([{ name: 'f' }])
  })
  assert.equal(snap.title, 'hello')
  assert.equal(snap.desc, 'd')
  assert.equal(snap.dateTs, 12345)
  assert.equal(snap.remindTs, 999)
  assert.deepEqual(snap.reminderOffsets, [1, 2])
  assert.equal(snap.deadlineTs, 555)
  assert.equal(snap.priority, 3)
  assert.equal(snap.important, 1)
  assert.equal(snap.sublist.length, 1)
  assert.equal(snap.todoImageList[0].url, 'u')
  assert.equal(snap.fileList[0].name, 'f')
  // snapshot values must be copies, never references into the row
  assert.notEqual(snap.reminderOffsets, [1, 2])
})

test('buildEditSnapshot defaults absent numeric fields to 0 and list fields to []', () => {
  const snap = buildEditSnapshot({ taskId: 't2', taskContent: 'x' })
  assert.equal(snap.priority, 0)
  assert.equal(snap.important, 0)
  assert.equal(snap.deadlineTs, 0)
  assert.deepEqual(snap.sublist, [])
  assert.deepEqual(snap.todoImageList, [])
})

test('ui/openEdit routes through the shared builder (snapshot keys match the fingerprint vocabulary)', () => {
  const s = { rightSidebarTodoEdit: null, inlineCreatedTaskId: 'x' }
  UI.mutations.openEdit(s, { taskId: 't9', taskContent: 'T' })
  const snap = s.rightSidebarTodoEdit
  assert.equal(snap.visible, true)
  assert.equal(snap.taskId, 't9')
  for (const k of EPS.FINGERPRINT_PANEL_KEYS) assert.ok(k in snap, `openEdit snapshot must carry fingerprint key ${k}`)
  assert.equal(s.inlineCreatedTaskId, '', 'user-initiated open clears the inline-create flag')
})

/* ---- 3. taskAbsentIn + component policy anchors ---- */

test('taskAbsentIn: absent from BOTH lists only', () => {
  const st = { todoList: [{ taskId: 'a' }], recycleList: [{ taskId: 'b' }] }
  assert.equal(taskAbsentIn(st, 'a'), false)
  assert.equal(taskAbsentIn(st, 'b'), false)
  assert.equal(taskAbsentIn(st, 'zz'), true, 'in neither list = truly deleted')
  assert.equal(taskAbsentIn(st, ''), false, 'empty id is never "absent"')
  assert.equal(taskAbsentIn(undefined, 'a'), false, 'missing store state must not read as deleted')
})

const panelSrc = read('renderer/js/components/EditPanel.vue')

test('EditPanel.hydrate rebuilds from the LIVE store row, not the open-time ui snapshot', () => {
  assert.match(panelSrc, /buildEditSnapshot\(/, 'hydrate must call the shared snapshot builder')
  assert.match(panelSrc, /todoList\.find\(t => t\.taskId === s\.taskId\)/,
    'the live row must be looked up by the OPEN task id (not this.task, which lags during task switches)')
  assert.match(panelSrc, /const src = live \? buildEditSnapshot\(live\) : s/,
    'open-time snapshot is only the fallback when the row cannot be found (recycle task)')
})

test('EditPanel auto-close guard verifies absence post-reload instead of trusting a transient null', () => {
  assert.match(panelSrc, /taskAbsentIn\(/, 'the guard must verify against the live lists')
  assert.match(panelSrc, /_closeVerifyTimer/, 'the close must be deferred behind a verification timer')
  assert.match(panelSrc, /clearTimeout\(this\._closeVerifyTimer\)/,
    'a reappearing row (reload landed) must cancel the pending close')
  // unmount hygiene: no dangling timer
  assert.match(panelSrc, /beforeUnmount[\s\S]*?clearTimeout\(this\._closeVerifyTimer\)/)
})
