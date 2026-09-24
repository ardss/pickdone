/**
 * D1 EditPanel god-file knives 2+3 — attachment & repeat orchestration extraction anchors.
 * maint/dw-arch 2026-09-24: pure moves to edit-panel/attachments.js and edit-panel/repeat.js;
 * these tests pin the seam (component delegates, module owns the orchestration, protocol unchanged).
 *
 * Run: node --test tests/unit/components/d1-editpanel-knives.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const PARENT = read('renderer/js/components/EditPanel.vue')
const ATT = read('renderer/js/components/edit-panel/attachments.js')
const REP = read('renderer/js/components/edit-panel/repeat.js')

/* ---------------- knife 2: attachments ---------------- */

test('knife2: attachments module exports the four orchestration entry points taking ctx', () => {
  for (const fn of ['pickFiles', 'onDescPaste', 'onDescDrop', 'uploadOne']) {
    assert.match(ATT, new RegExp('export (async )?function ' + fn + ' \\(ctx'), fn + ' takes ctx')
  }
})

test('knife2: uploads still funnel through markDirty + queueSave; img/file routing unchanged', () => {
  assert.match(ATT, /ctx\.imgList\.push\(item\); ctx\.markDirty\('imgs'\)/)
  assert.match(ATT, /ctx\.fileList\.push\(item\); ctx\.markDirty\('files'\)/)
  assert.match(ATT, /ctx\.queueSave\(\{\}\)/)
})

test('knife2: paste still prevents default, prefers png, dedupes multi-format entries', () => {
  assert.match(ATT, /e\.preventDefault\(\)/)
  assert.match(ATT, /imgItems\.find\(i => i\.type === 'image\/png'\) \|\| imgItems\[0\]/)
})

test('knife2: component delegates and keeps the child-emit protocol intact', () => {
  assert.match(PARENT, /pickFiles \(kind\) \{ return attachments\.pickFiles\(this, kind\) \}/)
  assert.match(PARENT, /onDescPaste \(e\) \{ return attachments\.onDescPaste\(this, e\) \}/)
  assert.match(PARENT, /onDescDrop \(e\) \{ return attachments\.onDescDrop\(this, e\) \}/)
  assert.match(PARENT, /uploadOne \(kind, f\) \{ return attachments\.uploadOne\(this, kind, f\) \}/)
  // scrollImgsIntoView stays on the component (focus/scroll is knife 4)
  assert.match(PARENT, /scrollImgsIntoView \(\) \{[\s\S]*?\.ep-imgs/)
  assert.match(ATT, /ctx\.scrollImgsIntoView\(\)/)
})

/* ---------------- knife 3: repeat ---------------- */

test('knife3: repeat module owns the modal commits and the group-count query', () => {
  assert.match(REP, /ctx\.\$store\.commit\('ui\/askRepeatEdit', ctx\.e\.taskId\)/)
  assert.match(REP, /ctx\.\$store\.commit\('ui\/askRepeatDelete', ctx\.e\.taskId\)/)
  assert.match(REP, /window\.todoAPI\.dbCall\('queryTodos', \{ deleted: 0, repeatId: ctx\.e\.repeatId \}\)/)
  assert.match(REP, /ctx\.repeatCount = rows\.length/)
})

test('knife3: component delegates; the throttled watcher piggyback stays in the parent', () => {
  assert.match(PARENT, /askRepeatEdit \(\) \{ return repeat\.askRepeatEdit\(this\) \}/)
  assert.match(PARENT, /askRepeatDelete \(\) \{ return repeat\.askRepeatDelete\(this\) \}/)
  assert.match(PARENT, /repeatGroupInfo \(\) \{ return repeat\.repeatGroupInfo\(this\) \}/)
  assert.match(PARENT, /this\.repeatGroupInfo\(\)/)
  assert.match(PARENT, /_rgRefreshAt/)
})
