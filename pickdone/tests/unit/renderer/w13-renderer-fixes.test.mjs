/**
 * W13 renderer fixes (2026-10-26) — regression tests.
 *
 * Covered:
 *   W13-1 (P2) tomatoEstimate.trimToCapacity: evicted ids must also leave the `fetched` Set and
 *         `epochOf` Map — the memo kept them short-circuiting ensureEstimate, so getEstimate()
 *         read a permanent stale 0 (per-task meta still held the value) and a recycled id could
 *         never recover its value.
 *   W13-2 (P2) TaskAccountModal.toggleEdit: clicking a ledger row while a manual-add draft is
 *         open must run the same discard-confirm flow requestClose uses (statsE.w7.
 *         accountDiscardConfirm + 'cancel'/'close' catch) instead of silently destroying the
 *         draft via commitDraftIfDirty's create early-return.
 *
 * Run: node --test tests/unit/renderer/w13-renderer-fixes.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- W13-1: trimToCapacity drops the eviction memo ---------------- */

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const mod = await import('../../../renderer/js/utils/tomatoEstimate.js')
const { setEstimate, getEstimate, ensureEstimate, _testInternals } = mod
const state = _testInternals.state

let metaTable = null
function installBridge () {
  metaTable = new Map()
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'getMeta') return metaTable.has(p) ? metaTable.get(p) : null
      if (op === 'setMeta') { metaTable.set(p[0], p[1]); return 'ok' }
      if (op === 'deleteMeta') { metaTable.delete(p); return 'ok' }
      return 'ok'
    }
  }
}
function uninstallBridge () { delete globalThis.window.todoAPI }
const wipe = () => {
  for (const k of Object.keys(state)) delete state[k]
  for (const k of [...Array(globalThis.localStorage.length).keys()].map(i => globalThis.localStorage.key(i))) {
    if (k.startsWith('tomatoEstimate')) globalThis.localStorage.removeItem(k)
  }
}

beforeEach(() => { wipe(); installBridge() })

test('W13-1: trimToCapacity evicts the id from the fetched memo — ensureEstimate re-fetches', async () => {
  // Seed + memoize an early id (lands as the OLDEST state key, first eviction victim).
  metaTable.set('tomatoEstimateState:trim-early', '7')
  await ensureEstimate('trim-early')
  assert.equal(getEstimate('trim-early'), 7, 'precondition: value memoized')

  // Overfill past capacity with the DB bridge detached so persistTask short-circuits fast
  // (the trim itself is synchronous and bridge-independent).
  const CAP = _testInternals.MAX_KEYS
  uninstallBridge()
  for (let i = 0; i < CAP + 20; i++) setEstimate('trim-cap-' + i, 1)
  installBridge()
  // reinstallBridge resets the fake meta table — reseed the per-task key: the DB side still
  // holds the value (only this module's mirror and memo were trimmed).
  metaTable.set('tomatoEstimateState:trim-early', '7')
  assert.ok(!('trim-early' in state), 'precondition: early id evicted from the mirror')

  // The meta key still holds the value — with the fix, ensureEstimate must NOT short-circuit on
  // the stale memo; it re-fetches and the value comes back. Without the fix getEstimate stays 0.
  assert.equal(getEstimate('trim-early'), 0, 'evicted mirror key reads 0')
  await ensureEstimate('trim-early')
  assert.equal(getEstimate('trim-early'), 7, 'evicted id re-fetches its still-present meta value')
})

test('W13-1: a recycled id over an evicted slot shows the NEW value, not a stale neighbor 0', async () => {
  metaTable.set('tomatoEstimateState:recy-early', '5')
  await ensureEstimate('recy-early')
  const CAP = _testInternals.MAX_KEYS
  uninstallBridge()
  for (let i = 0; i < CAP + 10; i++) setEstimate('recy-cap-' + i, 1)
  installBridge()
  // The recycled id's meta now holds a fresh peer-written value (e.g. the new task's estimate).
  metaTable.set('tomatoEstimateState:recy-early', '9')
  await ensureEstimate('recy-early')
  assert.equal(getEstimate('recy-early'), 9, 'recycled id reads the fresh meta value')
})

/* ---------------- W13-2: toggleEdit confirms before destroying the add draft ---------------- */

const ACCOUNT = read('renderer/js/components/TaskAccountModal.vue')

test('W13-2: toggleEdit runs the requestClose-shaped discard confirm for create drafts', () => {
  const src = ACCOUNT.replace(/\r/g, '')
  const i = src.indexOf('toggleEdit (r) {')
  assert.ok(i > -1, 'toggleEdit found')
  const body = src.slice(i, i + 1200)
  assert.match(body, /this\.draft && this\.draft\.create/, 'create-draft branch present')
  assert.match(body, /\$confirm\(this\.\$t\('statsE\.w7\.accountDiscardConfirm'\)/, 'same i18n key as requestClose')
  assert.match(body, /statsK\.TomatoAccount\.title/, 'same title key as requestClose')
  assert.match(body, /type: 'warning'/, 'same confirm shape as requestClose')
  assert.match(body, /\.then\(\(\) => this\.openRowEdit\(r\)\)/, 'confirm proceeds to the row edit')
  assert.match(body, /if \(e !== 'cancel' && e !== 'close'\)/, 'cancel/close are silently swallowed like requestClose')
  assert.match(body, /return/, 'the create-draft path returns — no silent replacement')
})

test('W13-2: edit drafts keep the commitDraftIfDirty path; row seeding goes through openRowEdit', () => {
  const src = ACCOUNT.replace(/\r/g, '')
  const i = src.indexOf('toggleEdit (r) {')
  const body = src.slice(i, i + 1800)
  assert.match(body, /this\.commitDraftIfDirty\(\)/, 'non-create drafts still auto-commit on switch')
  assert.match(body, /this\.openRowEdit\(r\)/, 'row seeding is centralized in openRowEdit')
  const oi = src.indexOf('openRowEdit (r) {')
  assert.ok(oi > -1, 'openRowEdit method exists')
  const obody = src.slice(oi, oi + 400)
  assert.match(obody, /this\.editingId = r\.tomatoId/, 'openRowEdit sets the editing row')
  assert.match(obody, /this\.draft = \{ tomatoId: r\.tomatoId/, 'openRowEdit seeds the edit draft')
})
