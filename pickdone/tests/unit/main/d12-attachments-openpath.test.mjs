/**
 * Fault-7 (D12 2026-10-01): 'open-file' local branch must resolve shell.openPath's ERROR STRING.
 *
 * The old branch was `shell.openPath(p); return true` — fire-and-forget. shell.openPath resolves
 * with '' on success and a non-empty ERROR STRING on failure (no association, blocked file,
 * removed drive), so the handler claimed success on every OS refusal and the renderer showed
 * nothing. Now: '' → true; error string → structured { ok:false, error, name } (mirrors the
 * {missing:true} shape the renderer already branches on); rejected promise maps to the same
 * shape instead of a raw IPC error.
 *
 * Run: node --test tests/unit/main/d12-attachments-openpath.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-openpath-'))
let SHELL_RESULT = { resolve: '' } // { resolve: '' | 'error string' } | { reject: Error }
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  shell: {
    openPath: async () => {
      if (SHELL_RESULT.reject) throw SHELL_RESULT.reject
      return SHELL_RESULT.resolve
    }
  }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachmentHandlers = require('../../../src/main/handlers/attachments.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const handlers = attachmentHandlers({
  isLocked: () => false,
  isSafeExternal: u => typeof u === 'string' && /^https?:\/\//i.test(u),
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
})

function seedAttachment () {
  const p = path.join(TMP, 'files', 't1_1_report.txt')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'hello')
  return p
}

test('Fault-7: openPath success (empty error string) still returns true', async () => {
  seedAttachment()
  SHELL_RESULT = { resolve: '' }
  const r = await handlers['open-file'](eMain, 'local://t1_1_report.txt')
  assert.equal(r, true)
})

test('Fault-7: openPath error string must NOT be discarded as success', async () => {
  seedAttachment()
  SHELL_RESULT = { resolve: 'This file does not have an app associated with it.' }
  const r = await handlers['open-file'](eMain, 'local://t1_1_report.txt')
  // red before the fix: `shell.openPath(p); return true` claimed success unconditionally
  assert.deepEqual(r, {
    ok: false,
    error: 'This file does not have an app associated with it.',
    name: 't1_1_report.txt'
  })
})

test('Fault-7: a rejected openPath maps to the same structured shape (no raw IPC error)', async () => {
  seedAttachment()
  SHELL_RESULT = { reject: new Error('shell blew up') }
  const r = await handlers['open-file'](eMain, 'local://t1_1_report.txt')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'shell blew up')
  assert.equal(r.name, 't1_1_report.txt')
})

test('Fault-7: missing-file structured result is unchanged', async () => {
  SHELL_RESULT = { resolve: '' }
  const r = await handlers['open-file'](eMain, 'local://never_synced.txt')
  assert.deepEqual(r, { missing: true, name: 'never_synced.txt' })
})
