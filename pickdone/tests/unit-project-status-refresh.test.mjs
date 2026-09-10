/** Regression for review P1 (2026-09-10): loadProjectMeta guarded status/deadline reads behind
 *  `=== undefined`, so a CLI `project --status/--deadline` write never reached a RUNNING app through
 *  the external-write reload path — the first load's values were sticky forever. Both meta reads are
 *  now unconditional; this test pins the re-read behavior. */
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
globalThis.window = {
  todoAPI: {
    dbCall: async (op, key) => {
      if (op !== 'getMeta') return null
      if (String(key).startsWith('projectStatus:')) return statusValue
      if (String(key).startsWith('projectDeadline:')) return deadlineValue
      if (String(key).startsWith('projectMilestones:')) return '[]'
      return null
    }
  }
}

const { default: categoryStore } = await import('../renderer/js/store/category.js')

function makeCtx () {
  const state = { projectIds: [9001], projectMeta: {} }
  return { state, commit (type, payload) { if (type === 'setProjectMeta') state.projectMeta = payload } }
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
