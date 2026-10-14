/**
 * F4 fix (2026-10-15): two CLI crash-guards, each red before the fix with a raw TypeError
 * surfaced as INTERNAL:
 *  - `events import --dry-run` on a non-array JSON file hit events.length of undefined;
 *    the real (non-dry) path already threw the structured EMPTY_EVENTS CliError.
 *  - `skill install` with USERPROFILE and HOME both unset hit path.join(undefined, ...).
 * Run: node --test tests/unit/cli/f4-cli-structured-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

const CLI = new URL('../../../cli/pickdone.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function run (args, envPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-cli-'))
  const env = {
    ...process.env,
    TODO_DB_DIR: path.join(dir, 'db'),
    TODO_USER_DATA_DIR: path.join(dir, 'ud'),
    ...envPatch,
  }
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: dir }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

test('F5: events import --dry-run on a non-array JSON file → structured EMPTY_EVENTS (not INTERNAL)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-events-'))
  const file = path.join(dir, 'events.json')
  fs.writeFileSync(file, JSON.stringify({ not: 'an array' }))
  const r = await run(['events', 'import', '--file', file, '--dry-run', '--json'])
  assert.equal(r.code, 1)
  const body = JSON.parse(r.stderr.trim().split('\n').pop())
  assert.equal(body.ok, false)
  assert.equal(body.error, 'EMPTY_EVENTS', 'red before the fix: TypeError → error:"INTERNAL"')
  assert.match(body.message, /non-empty JSON array/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('F5: a valid non-empty array still previews in dry-run (guard does not over-block)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-events-'))
  const file = path.join(dir, 'events.json')
  fs.writeFileSync(file, JSON.stringify([{ kind: 'task.add', content: 'hello' }]))
  const r = await run(['events', 'import', '--file', file, '--dry-run', '--json'])
  assert.equal(r.code, 0, 'stderr: ' + r.stderr)
  const start = r.stdout.indexOf('{')
  const body = JSON.parse(r.stdout.slice(start))
  assert.equal(body.ok, true)
  assert.equal(body.data.dryRun, true)
  assert.equal(body.data.total, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('F6: skill install with USERPROFILE and HOME unset → structured NO_HOME (not INTERNAL)', async () => {
  const r = await run(['skill', 'install', '--json'], { USERPROFILE: '', HOME: '' })
  assert.equal(r.code, 1)
  const body = JSON.parse(r.stderr.trim().split('\n').pop())
  assert.equal(body.ok, false)
  assert.equal(body.error, 'NO_HOME', 'red before the fix: path.join(undefined) TypeError → error:"INTERNAL"')
  assert.match(body.message, /home directory/i)
})
