/**
 * F4 P3 (2026-10-18) regression test — cli/pickdone.js fail() flush-before-exit:
 * fail() used to console.error + process.exit(1) synchronously; under a piped stderr the JSON
 * envelope could be TRUNCATED (the process tore down before the write drained) and the AI
 * consumer saw a half-envelope. The fix writes through stderr with a completion callback and
 * exits only after the flush. Regression signal: under a PIPE (the truncation scenario), the
 * error envelope arrives complete and parses.
 * Run: node --test tests/unit/cli/cli-fail-flush-envelope.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = path.join(ROOT, 'cli', 'pickdone.js')

function runCliExpectingFailure (args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-cli-fail-'))
  try {
    // stderr/stdout PIPED (not inherited) — the exact condition the truncation bug bit in
    const r = spawnSync(process.execPath, [CLI, ...args], { timeout: 180000,
      encoding: 'utf8',
      env: { ...process.env, TODO_DB_DIR: dir },
    })
    return r
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

test('fail(): a piped error envelope arrives complete and parses as {ok:false,...}', () => {
  const r = runCliExpectingFailure(['done', 'no-such-task-id', '--json'])
  assert.equal(r.status, 1, 'the failure exit code is preserved')
  assert.ok(r.stderr && r.stderr.trim(), 'an error envelope was written to stderr')
  const envelope = JSON.parse(r.stderr.trim()) // throws on truncation — the regression signal
  assert.equal(envelope.ok, false)
  assert.equal(envelope.command, 'done')
  assert.equal(envelope.error, 'TASK_NOT_FOUND')
  assert.ok(envelope.message)
  assert.equal(r.stdout.trim(), '', 'the envelope goes to stderr only, one judgment path')
})

test('fail(): the UNKNOWN_COMMAND path still emits a complete envelope', () => {
  const r = runCliExpectingFailure(['zzz-not-a-command', '--json'])
  assert.equal(r.status, 1)
  const envelope = JSON.parse(r.stderr.trim())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error, 'UNKNOWN_COMMAND')
})
