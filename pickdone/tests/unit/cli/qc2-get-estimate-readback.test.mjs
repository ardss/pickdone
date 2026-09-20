/* QC round 2 (adversarial) — `get` estimate read-back after the X2 per-task meta-key split.
 * The todos.estimate COLUMN is dead (always 0 post-X2); `get <id>` used to echo that 0 even
 * right after a successful `edit --estimate`, so the documented read-back showed the write
 * "vanishing". Behavior tests spawn the real CLI against an isolated temp better-sqlite3 DB.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-qc2-get-est-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runCliRaw = args => execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' })
const runCliJson = args => JSON.parse(runCliRaw([...args, '--json']))

test('qc2: get surfaces the live meta estimate, not the dead column, after edit --estimate', () => {
  const added = runCliJson(['add', 'qc2 estimate readback task'])
  const taskId = added.data ? added.data.taskId : added.taskId
  assert.ok(taskId, 'add --json returns the taskId')

  const setRes = runCliJson(['edit', taskId, '--estimate', '7'])
  assert.equal((setRes.data || setRes).tomatoEstimate, 7, 'edit reports the clamped estimate')

  const got = runCliJson(['get', taskId])
  const row = got.data || got
  assert.equal(row.estimate, 7, 'get must read the authoritative per-task meta key (was: dead column 0)')
})

test('qc2: get reports 0 for a task with no estimate key', () => {
  const added = runCliJson(['add', 'qc2 no estimate task'])
  const taskId = added.data ? added.data.taskId : added.taskId
  const got = runCliJson(['get', taskId])
  const row = got.data || got
  assert.equal(row.estimate, 0, 'no meta key = no estimate')
})

test('qc2: clamping roundtrip — out-of-range edit stores 20 and get reflects it', () => {
  const added = runCliJson(['add', 'qc2 clamp task'])
  const taskId = added.data ? added.data.taskId : added.taskId
  runCliJson(['edit', taskId, '--estimate', '99'])
  const got = runCliJson(['get', taskId])
  assert.equal((got.data || got).estimate, 20, 'clamp to 20 is visible on read-back')
})
