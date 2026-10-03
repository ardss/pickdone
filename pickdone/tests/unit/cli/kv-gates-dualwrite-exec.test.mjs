import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = path.join(ROOT, 'cli', 'check-dualwrite.cjs')

// KV-GATE-SINGLE (P1): check-dualwrite.cjs used to have exactly one execution site
// (cli/check-all.js), so any --no-verify commit (or any suite invocation that skipped
// check:all) bypassed the dual-write governance gate until CI - which is exactly how the
// gate-breaking tomato-store commits landed red. Root removed: the gate is now EXECUTED
// by the unit suite, which pre-commit step 4 (check-test-summary.cjs) and CI both run -
// the governance invariant holds under any suite invocation regardless of hook bypass.
// check-all.js keeps its fast-feedback stage; that duplication is feedback, not enforcement.

test('dualwrite gate executes green: every LS write point registered, no rotting ledger entries', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8' })
  assert.equal(r.status, 0, `check-dualwrite.cjs must exit 0 (unregistered write points / rotting entries):\n${r.stdout}\n${r.stderr}`)
})

test('dualwrite gate negative self-test: injected fake write point turns the gate red (not an always-green gate)', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env: { ...process.env, DUALWRITE_SELFTEST: '1' } })
  assert.equal(r.status, 0, `DUALWRITE_SELFTEST run must exit 0 (fake write point caught):\n${r.stdout}\n${r.stderr}`)
  assert.match(String(r.stdout) + String(r.stderr), /selftest|自测/i, 'self-test run must report the negative self-test result')
})
