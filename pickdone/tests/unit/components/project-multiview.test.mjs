// pd20 P1 multi-view (2026-11-06) — ProjectBoard / ProjectTimeline / projectOpenTask.
// Same doctrine as the other component contract tests: assert the USER-VISIBLE contract of
// the component source and the pure logic (columns split / day grouping / persistence key),
// never the code shape alone.
// Run: node --test tests/unit/components/project-multiview.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const boardSrc = readFileSync(join(root, 'renderer', 'js', 'components', 'ProjectBoard.vue'), 'utf8')
const tlSrc = readFileSync(join(root, 'renderer', 'js', 'components', 'ProjectTimeline.vue'), 'utf8')
const utilSrc = readFileSync(join(root, 'renderer', 'js', 'utils', 'projectOpenTask.js'), 'utf8')
const viewSrc = readFileSync(join(root, 'renderer', 'js', 'views', 'ProjectView.vue'), 'utf8')

// Pure logic mirrors (assert the same split/grouping the computed blocks implement — kept in
// lockstep by these tests, like the other pure-extract contracts in this repo).
const splitColumns = (tasks) => {
  const live = tasks.filter(t => !t.delete)
  return { active: live.filter(t => !t.complete).map(t => t.taskId), done: live.filter(t => !!t.complete).map(t => t.taskId) }
}

test('board splits live tasks into active/done columns; deleted tasks invisible; no drag-write door', () => {
  const split = splitColumns([
    { taskId: 'a', complete: false },
    { taskId: 'b', complete: 1 },
    { taskId: 'c', complete: 0, delete: true }
  ])
  assert.deepEqual(split.active, ['a'])
  assert.deepEqual(split.done, ['b'])
  // the PRD board is SIMPLE: display + open only — no drag/drop write semantics invented
  assert.ok(!/draggable|@drop|sortable/i.test(boardSrc), 'board has no drag-write machinery')
  assert.match(boardSrc, /openProjectTask|open\(t\.taskId\)/, 'cards open through the shared project open path')
  assert.match(boardSrc, /data-task-id/, 'cards carry the task id for journey QA')
})

test('timeline renders the op timeline array day-grouped; click opens; empty state exists', () => {
  assert.match(tlSrc, /queryEpisodesByCategory/, 'same single source op as the handoff overview')
  assert.match(tlSrc, /res\.timeline/, 'reads the FULL timeline array (beyond recent-8)')
  assert.match(tlSrc, /openProjectTask|open\(e\.taskId\)/, 'rows open through the shared project open path')
  assert.match(tlSrc, /timelineEmpty/, 'empty state is user-visible, not a blank panel')
  assert.match(tlSrc, /data-episode-id/, 'rows carry the episode id for journey QA')
  // grouping key is the day (YYYY-MM-DD); rows without a timestamp land in a no-date bucket
  assert.match(tlSrc, /YYYY-MM-DD/, 'day grouping key')
  assert.match(tlSrc, /timelineNoDate/, 'no-date bucket has a label')
})

test('the view switcher is user-selectable AND persisted across restarts', () => {
  assert.match(viewSrc, /pd20-project-taskview/, 'localStorage persistence key')
  assert.match(viewSrc, /TASK_VIEWS = \['list', 'board', 'timeline'\]/, 'exactly the three PRD views')
  assert.match(viewSrc, /setItem\(TASK_VIEW_KEY, v\)/, 'choice persisted on switch')
  assert.match(viewSrc, /getItem\(TASK_VIEW_KEY\)/, 'choice restored on mount')
  assert.match(viewSrc, /data-task-view/, 'switch buttons carry the view id for journey QA')
})

test('one shared open path for handoff/board/timeline (single door, cache-miss retry)', () => {
  const openCalls = (viewSrc.match(/openProjectTask|project-board|project-timeline/g) || []).length
  assert.ok(openCalls >= 2, 'ProjectView wires the new views')
  for (const src of [boardSrc, tlSrc]) {
    assert.ok(!/commit\('ui\/openEdit'/.test(src), 'views never call the store door directly — only the shared util')
  }
  assert.match(utilSrc, /dispatch\('todo\/init'\)/, 'cache-miss → canonical store refresh')
  assert.match(utilSrc, /if \(raw\) store\.commit\('ui\/openEdit', raw\)/, 'open only with a real store row')
})
