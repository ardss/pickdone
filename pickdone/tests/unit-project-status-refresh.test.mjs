/** Regression for review P1+P2 (2026-09-10): loadProjectMeta guarded status/deadline reads behind
 *  `=== undefined`, so a CLI `project --status/--deadline` write never reached a RUNNING app through
 *  the external-write reload path — the first load's values were sticky forever. Both meta reads are
 *  now unconditional; this test pins the re-read behavior. Later rounds: nextMilestone re-read got the
 *  same unconditional treatment (a CLI `milestone add/rm` write used to never reach a running app), and
 *  the snapshot-then-whole-replace commit became a per-id/key merge so in-flight optimistic writes are
 *  no longer wiped by the load's commit. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

// Browser-host globals before the store module (and its utils) load.
const require_ = createRequire(import.meta.url)
globalThis.dayjs = require_('dayjs') // utils/core.js expects the UMD global
const metaStore = new Map()
globalThis.localStorage = {
  getItem: k => (metaStore.has(k) ? metaStore.get(k) : null),
  setItem: (k, v) => { metaStore.set(k, String(v)) },
  removeItem: k => { metaStore.delete(k) }
}
let statusValue = 'paused'
let deadlineValue = '1770000000000'
let milestonesValue = '[]'
globalThis.window = {
  todoAPI: {
    dbCall: async (op, key) => {
      if (op !== 'getMeta') return null
      if (String(key).startsWith('projectStatus:')) return statusValue
      if (String(key).startsWith('projectDeadline:')) return deadlineValue
      if (String(key).startsWith('projectMilestones:')) return milestonesValue
      return null
    }
  }
}

const { default: categoryStore } = await import('../renderer/js/store/category.js')

function makeCtx () {
  const state = { projectIds: [9001], projectMeta: {} }
  return {
    state,
    // loadProjectMeta now commits mergeProjectMeta (P2 race fix); setProjectMeta kept for other callers
    commit (type, payload) {
      if (type === 'setProjectMeta') state.projectMeta = payload || {}
      else if (type === 'mergeProjectMeta') {
        const next = { ...state.projectMeta }
        for (const id of Object.keys(payload || {})) next[id] = Object.assign({}, next[id], payload[id])
        state.projectMeta = next
      }
    }
  }
}

test('first load reads status/deadline from meta', async () => {
  const ctx = makeCtx()
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].status, 'paused')
  assert.equal(ctx.state.projectMeta[9001].deadline, 1770000000000)
})

test('second load re-reads: a CLI-side status/deadline change reaches the running app', async () => {
  const ctx = makeCtx()
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].status, 'paused') // sticky under the old undefined-guard
  statusValue = 'active'
  deadlineValue = '0'
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].status, 'active', 'status must re-read on every load')
  assert.equal(ctx.state.projectMeta[9001].deadline, 0, 'deadline must re-read on every load')
})

test('invalid stored status normalizes to active', async () => {
  statusValue = 'bogus'
  const ctx = makeCtx()
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].status, 'active')
})

test('nextMilestone re-reads unconditionally: a CLI milestone add/rm reaches the running app', async () => {
  const today0 = +require_('dayjs')().startOf('day')
  milestonesValue = JSON.stringify([{ id: 'ms1', title: 'old', date: today0 + 864e5 }])
  const ctx = makeCtx()
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].nextMilestone.title, 'old')
  // CLI `milestone rm` removes the only milestone while the app stays open — the next reload must drop it
  milestonesValue = '[]'
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].nextMilestone, null, 'nextMilestone must re-read on every load (no lifetime cache)')
  // a milestone whose date rolled past no longer lingers after midnight either
  milestonesValue = JSON.stringify([{ id: 'ms2', title: 'past', date: today0 - 864e5 }])
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9001].nextMilestone, null, 'expired milestones must not be served from cache')
})

test('the load commits a MERGE, not a replace: sibling entries and in-window keys survive', async () => {
  statusValue = 'active'
  milestonesValue = '[]'
  const ctx = makeCtx()
  // a project not (yet) in projectIds and an optimistic key written while loads are in flight
  ctx.state.projectMeta = { 9002: { status: 'paused', custom: 'keep-me' }, 9001: { myOptimistic: true } }
  await categoryStore.actions.loadProjectMeta(ctx)
  assert.equal(ctx.state.projectMeta[9002].status, 'paused', 'entries absent from the patch must not be dropped')
  assert.equal(ctx.state.projectMeta[9002].custom, 'keep-me')
  assert.equal(ctx.state.projectMeta[9001].myOptimistic, true, 'keys absent from the patch must not be wiped')
  assert.equal(ctx.state.projectMeta[9001].status, 'active', 'loaded keys still win over stale local values')
})
