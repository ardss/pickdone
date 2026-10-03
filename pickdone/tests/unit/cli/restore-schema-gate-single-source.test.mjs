/**
 * Regression: restore-schema-gate-three-copies (2026-10-02, P3).
 *
 * The schema-version gate was triplicated: renderer SCHEMA_V (todoBackup.js), module-private
 * SUPPORTED_SCHEMA_V (dbRecovery.cjs), and an inline `> 1` literal in the CLI
 * (cli/lib-restore-backup.cjs). dbRecovery now EXPORTS SUPPORTED_SCHEMA_V and the CLI gate
 * consumes it, so a future bump cannot drift the CLI from the App. (Renderer↔main remain two
 * declarations by necessity: ESM↔CJS across the process boundary.)
 *
 * Run: node --test tests/unit/cli/restore-schema-gate-single-source.test.mjs
 */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-schemagate-')
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require_ = createRequire(import.meta.url)
const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))

const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCliFail = args => {
  try { execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return null } catch (e) {
    try { return JSON.parse(e.stderr || e.stdout) } catch { return { error: 'UNKNOWN', message: String(e.message) } }
  }
}
const runCli = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })).data

const dumpWith = schemaV => JSON.stringify({
  backup: {
    todoState: JSON.stringify({ schemaV, todoList: [{ taskId: 't1', taskContent: 'x' }], recycleList: [] }),
    categoryState: JSON.stringify({ schemaV, list: [] })
  }
})

test('single-source: SUPPORTED_SCHEMA_V is exported from dbRecovery.cjs', () => {
  assert.equal(typeof dbRecovery.SUPPORTED_SCHEMA_V, 'number', 'red before the fix: the constant was module-private')
})

test('single-source (source shape): the CLI gate references dbRecovery.SUPPORTED_SCHEMA_V, no bare `> 1` literal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/lib-restore-backup.cjs'), 'utf8')
  assert.ok(!/> 1\)/.test(src.split('schemaV guard')[1] || ''), 'red before the fix: inline `> 1` schemaV comparison present')
  assert.match(src, /dbRecovery\.SUPPORTED_SCHEMA_V/, 'the gate must consume the exported binding')
})

test('boundary: schemaV === SUPPORTED_SCHEMA_V validates OK', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'ok-v-current.json')
  fs.writeFileSync(f, dumpWith(dbRecovery.SUPPORTED_SCHEMA_V))
  const out = runCli(['restore-backup', f, '--json'])
  assert.equal(out.todos, 1, 'a current-version dump still validates')
})

test('boundary: schemaV === SUPPORTED_SCHEMA_V + 1 throws SNAPSHOT_FUTURE (drift tripwire)', () => {
  // CAVEAT: green today only because the literal is 1; this is a DRIFT TRIPWIRE — it goes red the
  // moment someone bumps SUPPORTED_SCHEMA_V without moving this gate (which is the point).
  const f = path.join(process.env.TODO_DB_DIR, 'future-v.json')
  fs.writeFileSync(f, dumpWith(dbRecovery.SUPPORTED_SCHEMA_V + 1))
  const r = runCliFail(['restore-backup', f, '--json'])
  assert.equal(r && r.error, 'SNAPSHOT_FUTURE', 'a future-version dump must be refused')
  assert.match(r && r.message, /schemaV/)
})
