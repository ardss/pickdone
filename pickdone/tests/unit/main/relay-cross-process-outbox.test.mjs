import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRelay, memoryStore, startRelayServer } from '../../../server/sync-relay.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'

const exec = promisify(execFile)
const child = path.resolve('tests/fixtures/relay-cross-process/child.cjs')
const entry = (rows, id) => rows.find(r => r.taskId === id)

async function device(dir, op, payload = {}) {
  const args = [child, '--dir', dir, '--op', op, '--payload', JSON.stringify(payload)]
  let output
  try {
    output = await exec(process.execPath, args, { cwd: process.cwd(), timeout: 30000, maxBuffer: 1048576, windowsHide: true })
  } catch (e) {
    // Known libuv teardown class (win32 async.c UV_HANDLE_CLOSING): the child can print its
    // final JSON line successfully and STILL die non-zero while native modules unwind. The
    // result line is the contract; judge the op by it, not by the exit code — but only when
    // a parseable final line actually exists.
    const lines = String(e.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    const last = lines.at(-1)
    if (last && last.startsWith('{') && /"ok":/.test(last)) { output = { stdout: e.stdout } } else { throw new Error('device ' + op + ' failed: ' + (e.stdout || '') + (e.stderr || '') + e.message) }
  }
  const line = output.stdout.trim().split(/\r?\n/).at(-1)
  const result = JSON.parse(line)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.result
}

test('real encrypted TodoDB survives two-device process restarts and replays offline edits', { timeout: 120000 }, async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-real-db-A-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-real-db-B-'))
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const port = server.address().port
  const account = 'proc-db-' + Date.now()
  const baseUrl = 'http://127.0.0.1:' + port
  const rootKey = generateAccountRootKey()
  let listening = true
  try {
    const enabledA = await device(dirA, 'enable', { account, baseUrl, rootKey })
    assert.equal(enabledA.enabled, true)
    await device(dirA, 'upsert', { todo: { taskId: 'proc-task', taskContent: 'written on A', createTime: 1, updateTime: 100 } })
    const pushA = await device(dirA, 'sync')
    assert.equal(pushA.ok, true, JSON.stringify(pushA))
    assert.ok(pushA.pushed >= 1, 'A must send durable revision')

    const encA = await device(dirA, 'probe-enc')
    assert.equal(encA.dbFile, true)
    assert.equal(encA.keyFile, true)
    assert.equal(encA.plaintextHeader, false, 'real DB must be encrypted')

    const enabledB = await device(dirB, 'enable', { account, baseUrl, rootKey })
    assert.equal(enabledB.enabled, true)
    const pullB = await device(dirB, 'sync')
    assert.equal(pullB.ok, true, JSON.stringify(pullB))
    assert.ok(pullB.pulled >= 1)
    assert.equal(entry(await device(dirB, 'get-all'), 'proc-task')?.taskContent, 'written on A')
    assert.equal(entry(await device(dirA, 'get-all'), 'proc-task')?.taskContent, 'written on A')

    // Each device() is a fresh OS child process. This is not a same-process db re-init.
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
    listening = false

    await device(dirA, 'upsert', { todo: { taskId: 'proc-task', taskContent: 'offline change on A', createTime: 1, updateTime: Date.now() + 50000 } })
    const offline = await device(dirA, 'sync')
    assert.equal(offline.ok, false, 'offline round should fail closed')
    assert.equal(entry(await device(dirA, 'get-all'), 'proc-task')?.taskContent, 'offline change on A')

    await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
    listening = true
    const retried = await device(dirA, 'sync')
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.ok(retried.pushed >= 1, 'process-restarted A must replay DB revision')

    const received = await device(dirB, 'sync')
    assert.equal(received.ok, true, JSON.stringify(received))
    assert.equal(entry(await device(dirB, 'get-all'), 'proc-task')?.taskContent, 'offline change on A')
    await device(dirA, 'sync')
    assert.equal(entry(await device(dirA, 'get-all'), 'proc-task')?.taskContent, 'offline change on A')
    await device(dirB, 'sync')
    assert.equal((await device(dirB, 'get-all')).filter(r => r.taskId === 'proc-task').length, 1, 'idempotent replay')
  } finally {
    if (listening) {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(() => resolve()))
    }
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  }
})
