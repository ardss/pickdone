/**
 * PA-1 regression — the op-feedback allowlists must have a retirement path.
 *
 * Root removed: grow-only exemption lists. check-op-feedback.js previously only tested
 * hit-∉-allowlist → red; an allowlist entry whose file no longer dispatches the reserved op
 * (dispatch removed or renamed, e.g. todo/deleteTodo → todo/deleteTodosMany) stayed in the
 * list forever, so the exemption silently outlived its review. The gate now flags any
 * allowlist entry with no matching dispatch in the scanned union as a dead entry and exits
 * non-zero (same lifecycle check-command-bus.cjs enforces on WRITE_OPS).
 *
 * Invariant asserted: a gate whose allowlist contains a basename with no matching dispatch
 * in the scan surface must exit non-zero; a live entry (matching dispatch present) must not.
 *
 * Run: node --test tests/unit/cli/op-feedback-allowlist-retirement.test.mjs
 */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const GATE = path.join(REPO, 'cli', 'check-op-feedback.js')

// Build a synthetic scan tree mirroring the gate's ROOT layout (gate derives ROOT from its own
// __dirname, so the gate copy must sit at <tmp>/cli/check-op-feedback.js).
function makeTree () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-feedback-gate-'))
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'renderer/js/components'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'renderer/js/views'), { recursive: true })
  fs.copyFileSync(GATE, path.join(tmp, 'cli/check-op-feedback.js'))
  return tmp
}

const writeSfc = (tmp, rel, src) => {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, src)
}

const runGate = tmp =>
  spawnSync(process.execPath, [path.join(tmp, 'cli', 'check-op-feedback.js')], { encoding: 'utf8' })

test('dead UPDATE_FIELDS_ALLOWLIST entry (no matching dispatch anywhere) fails the gate', () => {
  const tmp = makeTree()
  // live file exercises the normal scan; it dispatches a DIFFERENT op than the injected entry
  writeSvcLiveUpdate(tmp, 'renderer/js/components/LiveView.vue')
  // inject a stale entry: basename exists in the tree but dispatches nothing allowlisted
  const gatePath = path.join(tmp, 'cli/check-op-feedback.js')
  let gate = fs.readFileSync(gatePath, 'utf8')
  gate = gate.replace(
    "const UPDATE_FIELDS_ALLOWLIST = [",
    "const UPDATE_FIELDS_ALLOWLIST = [\n  'StaleModal.vue',"
  )
  writeSfc(tmp, 'renderer/js/components/StaleModal.vue', '<template><div /></template>\n')
  fs.writeFileSync(gatePath, gate)
  const r = runGate(tmp)
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /StaleModal\.vue/)
  assert.match(r.stderr, /死条目/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('dead DELETE_ALLOWLIST entry fails the gate (file gone entirely)', () => {
  const tmp = makeTree()
  const gatePath = path.join(tmp, 'cli/check-op-feedback.js')
  let gate = fs.readFileSync(gatePath, 'utf8')
  gate = gate.replace(
    "const DELETE_ALLOWLIST = [",
    "const DELETE_ALLOWLIST = [\n  'GhostView.vue',"
  )
  fs.writeFileSync(gatePath, gate)
  // GhostView.vue does not exist anywhere in the tree
  const r = runGate(tmp)
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /GhostView\.vue/)
  assert.match(r.stderr, /死条目/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('live allowlist entry (matching dispatch present) keeps the gate green', () => {
  const tmp = makeTree()
  // synthetic tree only contains LiveModal.vue, so prune the shipped entries (they'd all be
  // dead here by design) and keep exactly one live entry
  let gate = fs.readFileSync(path.join(tmp, 'cli/check-op-feedback.js'), 'utf8')
  gate = gate.replace(/const UPDATE_FIELDS_ALLOWLIST = \[[\s\S]*?\]/,
    "const UPDATE_FIELDS_ALLOWLIST = [\n  'LiveModal.vue',\n]")
  fs.writeFileSync(path.join(tmp, 'cli/check-op-feedback.js'), gate)
  writeSfc(tmp, 'renderer/js/views/LiveModal.vue',
    "<script setup>\nimport { useStore } from 'vuex'\nconst store = useStore()\nstore.dispatch('todo/updateTodoFields', {})\n</script>\n")
  const r = runGate(tmp)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('current real tree passes the gate with the retirement check in place', () => {
  // gates the shipped allowlists: after removing the 6 stale entries the repo must be green
  execFileSync(process.execPath, [GATE], { stdio: 'pipe' })
})

function writeSvcLiveUpdate (tmp, rel) {
  writeSfc(tmp, rel,
    "<script setup>\nimport { useStore } from 'vuex'\nconst store = useStore()\nstore.dispatch('todo/updateTodoFields', {})\n</script>\n")
}
