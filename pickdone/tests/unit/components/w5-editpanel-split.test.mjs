/**
 * W5 S4 split — EditPanel decomposition anchors (source-level, node:test, no mount).
 * Locks the architecture: children only emit, the parent owns the save pipeline and
 * is the single dispatcher of todo/updateTodoFields in the edit-panel family.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const PARENT = 'renderer/js/components/EditPanel.vue'
const KIDS = [
  'renderer/js/components/edit-panel/EpReminders.vue',
  'renderer/js/components/edit-panel/EpSubtasks.vue',
  'renderer/js/components/edit-panel/EpAttachments.vue',
  'renderer/js/components/edit-panel/EpDependencies.vue'
]

test('split: the four edit-panel child components exist', () => {
  for (const f of KIDS) assert.ok(read(f).includes('<template>'), `${f} missing`)
})

test('split: children never touch the save pipeline (emit-only contract)', () => {
  for (const f of KIDS) {
    const src = read(f)
    assert.ok(!src.includes('updateTodoFields'), `${f} must not dispatch todo/updateTodoFields`)
    assert.ok(!src.includes('queueSave'), `${f} must not call queueSave`)
    assert.ok(!src.includes('markDirty'), `${f} must not call markDirty`)
  }
})

test('split: children declare their change events', () => {
  assert.match(read(KIDS[0]), /emits: \['commit', 'clear', 'offsets'\]/)
  assert.match(read(KIDS[1]), /emits: \['add', 'toggle', 'remove', 'move'\]/)
  assert.match(read(KIDS[2]), /emits: \['pick', 'preview', 'remove'\]/)
  assert.match(read(KIDS[3]), /emits: \['patch'\]/)
})

test('split: EditPanel owns the unified save pipeline via utils/editSave.js', () => {
  const src = read(PARENT)
  assert.match(src, /import \{ createSaveQueue \} from '\.\.\/utils\/editSave\.js'/)
  assert.match(src, /this\._save = createSaveQueue\(this\.\$store, \{/)
  // dirty list-style fields collected at drain time, keyed like the original flags
  for (const k of ['subtasks', 'imgs', 'files', 'preds']) {
    assert.ok(src.includes(`${k}: {`), `dirtyPatchFor missing key ${k}`)
  }
})

test('split: restoreFromBin drains only subtasks/imgs/files through takeDirty (original flag wipe semantics)', () => {
  const src = read(PARENT)
  assert.match(src, /takeDirty\(\['subtasks', 'imgs', 'files'\]\)/)
})

test('split: the attachmentUrlPresent pure block stays in EditPanel.vue (a11y test anchor position)', () => {
  const src = read(PARENT)
  const s = src.indexOf('[component-fixes] pure-start')
  const e = src.indexOf('[component-fixes] pure-end')
  assert.ok(s >= 0 && e > s, 'pure markers present')
  assert.match(src.slice(s, e), /function attachmentUrlPresent \(row, url\)/)
})

test('split: parent still gates the deps block on the two-condition devMode and composes the children', () => {
  const src = read(PARENT)
  assert.match(src, /devMode \(\) \{ const s = this\.\$store\.state\.settings; return !!s\.developerMode && !!s\.showDepsModule \}/)
  assert.ok(src.includes('<div v-if="devMode" class="ep-cat-wrap">'), 'deps block keyed on devMode')
  for (const tag of ['<ep-reminders', '<ep-subtasks', '<ep-attachments', '<ep-dependencies']) {
    assert.ok(src.includes(tag), `parent template missing ${tag}`)
  }
  // components option wires the children (not global registration)
  assert.match(src, /components: \{ EpReminders, EpSubtasks, EpAttachments, EpDependencies \}/)
})

test('split: child view blocks carry their own styles; parent keeps the shared selectors', () => {
  assert.match(read(KIDS[0]), /\.ep-remind-pop/)
  assert.match(read(KIDS[1]), /\.ep-sub-move/)
  assert.match(read(KIDS[2]), /\.ep-img-cell/)
  assert.match(read(KIDS[3]), /\.ep-dep-truncated/)
  const src = read(PARENT)
  // shared across parent rows and child DOM (deadline/repeat/done rows)
  assert.match(src, /\.ep-remind-clear \{/)
  assert.match(src, /\.ep-remind-label \{/)
  assert.match(src, /\.ep-sub-check \{/)
})
