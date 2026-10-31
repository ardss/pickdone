/* W22 regression pin: check-file-size.cjs commitments expiry must use the LOCAL date.
 * Root cause (2026-10-30): `new Date().toISOString().slice(0, 10)` is the UTC day — in
 * UTC+8 a commitment due "today" stayed green for the first 8 local hours of the day
 * (08:00 local = 00:00 UTC), i.e. overdue commitments fired 8h late.
 * Fix: local YYYY-MM-DD via getFullYear/getMonth/getDate. Proven on a temp fixture tree
 * via the GATE_ROOT override, with the ratchet baseline pointed at a fixture through the
 * new GATE_BASELINE override (default unchanged: cli/structure-baseline.json).
 * Run: node --test tests/unit/cli/w22-commitments-local-date.test.mjs */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
// Fixture anchor inside the checkout (NOT os.tmpdir()) — same reasoning as
// w18-gate-fixes.test.mjs / gate-must-fail-golden.test.mjs. .tmp-* is gitignored.
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w22-commitments-local-date')
const madeDirs = []

const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

/** Local YYYY-MM-DD — the exact format the fixed gate computes. */
function localToday (offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function mkTree (name, commitments) {
  const root = fs.mkdtempSync(FIX_ROOT + '-' + name + '-')
  madeDirs.push(root)
  // One tiny legal file so the scan itself stays green; only the commitment can flip it.
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(root, 'shared', 'tiny.js'), 'module.exports = 1\n')
  const baselinePath = path.join(root, 'structure-baseline.json')
  fs.writeFileSync(baselinePath, JSON.stringify({
    files: {},
    commitments: { 'shared/tiny.js': { due: commitments.due, note: commitments.note || 'W22 fixture: split into lib + view, tracked in lane notes' } }
  }, null, 2) + '\n')
  return { root, baselinePath }
}

function runGate (root, baselinePath) {
  const env = { ...GIT_SAFE_ENV, GATE_ROOT: root, GATE_BASELINE: baselinePath }
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-file-size.cjs')], { timeout: 120000, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

test('commitments: due = LOCAL today must NOT be red (UTC-day judgment fired it 8h early in UTC+8 mornings)', () => {
  const t = mkTree('due-local-today', { due: localToday(0) })
  const r = runGate(t.root, t.baselinePath)
  assert.equal(r.code, 0, 'a commitment due today is not yet overdue\n' + r.out)
  assert.doesNotMatch(r.out, /超期/, 'must not report the commitment as overdue\n' + r.out)
})

test('commitments: due = yesterday must be red', () => {
  const t = mkTree('due-yesterday', { due: localToday(-1) })
  const r = runGate(t.root, t.baselinePath)
  assert.equal(r.code, 1, 'an overdue commitment must fail the gate\n' + r.out)
  assert.match(r.out, /拆分承诺已超期/, 'red must name the overdue commitment\n' + r.out)
})

test('commitments: due = tomorrow stays green (boundary sanity)', () => {
  const t = mkTree('due-tomorrow', { due: localToday(1) })
  const r = runGate(t.root, t.baselinePath)
  assert.equal(r.code, 0, 'a future commitment must stay green\n' + r.out)
})
