import { test } from 'node:test'
import assert from 'node:assert/strict'
/* Coverage boost (2026-10-21 reconciliation): milestones.js error branches had no direct
 * coverage, dragging the funcs ratchet to 57.94 < 58. Behavior-level tests only.
 * (windowBoundsVisible is already covered by f4-quit-chain-sync-window-fixes.)
 * Run: node --test tests/unit/main/cov-boost-20261021.test.mjs */
// ---- milestones.js error branches ----
let failMode = ''
globalThis.window = { todoAPI: { dbCall: async (op) => {
  if (op === 'setMeta') { if (failMode === 'setMeta') throw new Error('db gone'); return }
  if (failMode === 'getMeta') throw new Error('db gone')
  return null
} } }
const { loadMilestones, saveMilestones } = await import('../../../renderer/js/utils/milestones.js')

test('loadMilestones: corrupt JSON blob degrades to empty list instead of throwing', async () => {
  const meta = new Map([['projectMilestones:px', '{not json']])
  const orig = globalThis.window.todoAPI.dbCall
  globalThis.window.todoAPI.dbCall = async (op, p) => meta.get(p) ?? null
  try { assert.deepEqual(await loadMilestones('px'), []) } finally { globalThis.window.todoAPI.dbCall = orig }
})

test('saveMilestones: setMeta failure surfaces as savePromise=false (no silent loss)', async () => {
  failMode = 'setMeta'
  const orig = console.error
  console.error = () => {}
  try {
    const out = saveMilestones('py', [{ id: 'a', title: 'T', date: 1 }])
    assert.equal(await out.savePromise, false, 'write failure must be observable via savePromise')
  } finally { console.error = orig; failMode = '' }
})

test('saveMilestones: db bridge unavailable resolves false (in-memory fallback contract)', async () => {
  const origCall = globalThis.window.todoAPI.dbCall
  globalThis.window.todoAPI.dbCall = () => { throw new Error('bridge down') }
  const orig = console.error
  console.error = () => {}
  try {
    const out = saveMilestones('pz', [{ id: 'a', title: 'T', date: 1 }])
    assert.equal(await out.savePromise, false)
  } finally { globalThis.window.todoAPI.dbCall = origCall; console.error = orig }
})
