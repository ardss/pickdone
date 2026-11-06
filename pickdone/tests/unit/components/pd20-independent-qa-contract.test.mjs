// Independent, source-only audit sentinels for the eb6a62d7 candidate.
// These deliberately avoid application dependencies so the QA snapshot can run offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = rel => readFileSync(path.join(app, rel), 'utf8')

test('legacy project management surfaces remain in ProjectView', () => {
  const view = read('renderer/js/views/ProjectView.vue')
  assert.match(view, /import TodoGroupBlock/)
  assert.match(view, /import DepView/)
  assert.match(view, /import ProjectDocs/)
  assert.match(view, /import \{ loadMilestones, saveMilestones/)
  assert.match(view, /<project-docs\b/)
  assert.match(view, /<pd-dep-view\b/)
  assert.match(view, /<group-block\b/)
})

test('work context composes existing task subtasks, episodes, sources, and handoff', () => {
  const cli = read('cli/lib-work.cjs')
  assert.match(cli, /lib\.parseSubs\(t\)/)
  assert.match(cli, /queryEpisodesByTask/)
  assert.match(cli, /querySourcesByTask/)
  assert.match(cli, /buildHandoff\(handoffEpisodes, sources/)
  assert.match(cli, /handoffMarkdown: handoff\.text/)
})

test('SourceRef retains a machine-local file boundary in LAN egress', () => {
  const keys = read('shared/machine-local-keys.mjs')
  const egress = read('src/main/lan-sync-egress.js')
  const epiOps = read('src/main/db-episode-ops.cjs')
  assert.match(keys, /export function isMachineLocalSourceRef/)
  assert.match(keys, /String\(providerId \|\| ''\) === 'file'/)
  assert.match(egress, /isMachineLocalSourceRef\(r\.providerId, r\.externalId\)/)
  assert.match(epiOps, /source_refs/)
  assert.match(epiOps, /task_source_links/)
})

test('integrated candidate includes Board and work-episode Timeline alongside original project sections', () => {
  const view = read('renderer/js/views/ProjectView.vue')
  assert.match(view, /ProjectBoard|ProjectTimeline/)
  assert.equal(existsSync(path.join(app, 'renderer/js/components/ProjectBoard.vue')), true)
  assert.equal(existsSync(path.join(app, 'renderer/js/components/ProjectTimeline.vue')), true)
  assert.ok(read('renderer/js/components/ProjectTimeline.vue').includes('this.taskTitles[String(e.taskId)]'), 'task titles are joined to work episodes')
  assert.ok(!read('src/main/db-episode-ops.cjs').includes('timeline.length < 300'), 'no hidden 300-record truncation')
  // Existing milestone timeline is a separate, pre-existing project feature.
  assert.match(view, /Milestone timeline/)
})

test('handoff UI and rollup expose recent work and continuation fields without claiming a full history', () => {
  const handoff = read('renderer/js/components/ProjectHandoff.vue')
  const ops = read('src/main/db-episode-ops.cjs')
  const work = read('renderer/js/components/editpanel/EditPanelWork.vue')
  assert.match(handoff, /queryEpisodesByCategory/)
  assert.match(handoff, /lastNextAction/)
  assert.match(ops, /recent\.length < 8/)
  assert.match(work, /nextAction/)
  assert.match(work, /sourceRefId/)
  assert.match(work, /buildHandoff/)
})
