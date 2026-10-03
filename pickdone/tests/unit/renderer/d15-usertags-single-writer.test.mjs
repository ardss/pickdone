/**
 * D15 single-writer regression (KV-USERTAGS-TRIPLE-WRITER): the 'userTags' meta row has exactly
 * ONE writer function — ui/commitUserTags — owning the optimistic-set + awaited meta put +
 * revert-on-rejection + surface policy. create/rename/remove all route through it.
 * Fails on pre-fix code: createTag's revert path was a separate hand-rolled copy in
 * sideNavHandlers.js, not reachable from any ui.js action, and the source had three writers.
 * Run: node --test tests/unit/renderer/d15-usertags-single-writer.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ===== shared db bridge stub ===== */
let failSetMeta = false
globalThis.window.todoAPI = {
  dbCall (op, params) {
    if (op === 'setMeta' && Array.isArray(params) && params[0] === 'userTags') {
      return failSetMeta ? Promise.reject(new Error('disk full')) : Promise.resolve('ok')
    }
    return Promise.resolve(null)
  }
}

// shared assertion: through the single action, a rejected meta put reverts in-memory state
async function assertRevert (act) {
  const ui = (await import('../../../renderer/js/store/ui.js')).default
  const state = { userTags: ['keep'] }
  const ctx = {
    state,
    commit (m, p) { ui.mutations[m](state, p) },
    dispatch (a, p) { return ui.actions.commitUserTags.call(ctx, ctx, p) } // vuex-like routing to the owner action
  }
  failSetMeta = true
  await assert.rejects(act(ui, ctx), /disk full/)
  assert.deepEqual(state.userTags, ['keep'], 'in-memory userTags reverted by the owner action')
  failSetMeta = false
}

test('commitUserTags is the single revert-safe writer for create/rename/remove', async () => {
  await assertRevert((ui, ctx) => ui.actions.commitUserTags.call(ctx, ctx, ['keep', 'new']))
  await assertRevert((ui, ctx) => ui.actions.renameUserTag.call(ctx, ctx, { from: 'keep', to: 'KEEP' }))
  await assertRevert((ui, ctx) => ui.actions.removeUserTag.call(ctx, ctx, 'keep'))
})

test('createTag routes through ui/commitUserTags (no hand-rolled writer in sideNavHandlers)', async () => {
  const handlers = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const ui = (await import('../../../renderer/js/store/ui.js')).default
  const state = { ui: { userTags: [] } }
  let ownerDispatches = 0
  const vm = {
    $prompt: async () => ({ value: ' #newtag ' }),
    $t: k => k,
    tags: [],
    $message: { error: () => {}, warning: () => {} },
    $store: {
      state,
      commit (m, p) { if (m === 'ui/setUserTags') state.ui.userTags = p },
      async dispatch (a, p) {
        ownerDispatches++
        const ctx = { state: state.ui, commit (m, v) { if (m === 'setUserTags') state.ui.userTags = v } }
        return ui.actions.commitUserTags.call(ctx, ctx, p)
      }
    }
  }
  failSetMeta = true
  await handlers.createTag(vm)
  failSetMeta = false
  assert.equal(ownerDispatches, 1, 'createTag went through the single owner action')
  assert.deepEqual(state.ui.userTags, [], 'failed create reverted in-memory by the owner action')
  // and the success path through the same action persists
  await handlers.createTag(vm)
  assert.deepEqual(state.ui.userTags, ['newtag'])
})

test('source invariant: exactly one renderer site writes the userTags meta row', () => {
  const hits = []
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.js') && fs.readFileSync(p, 'utf8').split("['userTags', JSON.stringify").length > 1) {
        hits.push(p)
      }
    }
  }
  walk(path.join(ROOT, 'renderer/js'))
  assert.equal(hits.length, 1, `only ui/commitUserTags writes the key (found: ${hits.join(', ')})`)
  assert.match(read('renderer/js/store/ui.js'), /async commitUserTags \(/, 'the owner action exists in the store')
})
