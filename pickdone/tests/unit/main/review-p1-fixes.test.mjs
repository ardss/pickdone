/* Review-round P1 regressions (2026-09-22):
 *   P1-1  renderer commit() facade unwraps the batch result shape and REJECTS on failedIndex
 *         (pre-fix: every renderer write failure resolved as success — optimistic state stuck,
 *         saveFailed banner never fired)
 *   P1-2  pairing-establishment ops (syncPairWithCode/syncAddPeer/syncPairRespond/syncPairRequest)
 *         are main-window-only (pairing routes the whole DB to a new peer — higher capability
 *         than the already-gated unpair/rename)
 *
 * Run: node --test tests/unit/main/review-p1-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(require_.resolve('../../../package.json')))

test('P1-1: commit() facade rejects when the batch result carries failedIndex >= 0', async () => {
  const { commit } = await import(pathToFileURL(path.join(root, 'renderer/js/utils/commandBus.js')).href)
  // stub window.commands with the raw batch-shaped resolution
  const calls = []
  globalThis.window = {
    commands: {
      commit: (entity, verb, payload, opts) => {
        calls.push({ entity, verb, payload, opts })
        if (calls.length === 1) return Promise.resolve({ results: [{ ok: 1 }], failedIndex: 0, error: 'database is locked' })
        if (calls.length === 2) return Promise.resolve({ results: [{ ok: 1 }, { ok: 2 }], failedIndex: -1, error: null })
        return Promise.resolve({ plain: true })
      }
    }
  }
  await assert.rejects(commit('todo', 'put', { taskId: 't1' }), /database is locked/, 'partial failure must reject, not resolve')
  const res = await commit('todo', 'put', { taskId: 't2' })
  assert.deepEqual(res, [{ ok: 1 }, { ok: 2 }], 'multi-entry full success returns the results array')
  const res2 = await commit('todo', 'put', { taskId: 't3' })
  assert.deepEqual(res2, { plain: true }, 'non-batch shapes pass through untouched')
})
