import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = path.join(ROOT, 'cli', 'check-schema-manifests.cjs')

// PA-3: the runtime self-healing backstop in db.js's init path (probe todoToRow keys vs
// PRAGMA table_info(todos), silently ALTER TABLE the missing columns with heuristic
// defaults) masked SCHEMA/MIGRATIONS dual-manifest drift on every startup path (electron
// main and the CLI share the same db.js). Root removed: drift now fails red at CI via
// cli/check-schema-manifests.cjs and, if it slipped through, dies loudly at the upsert
// prepare. These tests EXECUTE the gate from the unit suite (run by pre-commit step 4 and
// CI) so the invariant is not pinned to the single check-all.js invocation point.

test('schema manifest gate executes green: todoToRow ⊆ SCHEMA, migration ADD COLUMNs ⊆ SCHEMA, no ALTER backstop in db.js', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8' })
  assert.equal(r.status, 0, `check-schema-manifests.cjs must exit 0 (manifest drift):\n${r.stdout}\n${r.stderr}`)
})

test('schema manifest gate negative self-test: a fake todoToRow column expectation turns the gate red (the gate is the regression test)', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env: { ...process.env, SCHEMA_MANIFEST_SELFTEST: '1' } })
  assert.equal(r.status, 0, `SCHEMA_MANIFEST_SELFTEST run must exit 0 (fake expectation caught):\n${r.stdout}\n${r.stderr}`)
  assert.match(String(r.stdout) + String(r.stderr), /selftestFakeColumn/, 'self-test must report the injected fake column as the caught drift')
})
