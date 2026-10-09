/**
 * [fix 2026-10-09] Two P3 main-process fixes, pinned by source + behavior:
 *
 * 1. Windows session-end flush: on shutdown/logoff Electron fires `session-end` and kills the
 *    process WITHOUT running before-quit/will-quit, so the scheduler's reminder-dedupe watermark
 *    (flushFiredNow, 60s debounce) was lost on every OS shutdown. main/index.js now registers a
 *    session-end handler doing a synchronous best-effort scheduler.flushFiredNow() in a try/catch.
 *    session-end cannot do async work reliably, and the renderer's debounced writes cannot be
 *    flushed from main (they live in renderer memory) — both limits are documented in the source.
 * 2. Attachment names: saveAttachment previously produced Windows reserved device names
 *    (con.png -> CreateFile fails) and overlong basenames (ENAMETOOLONG in deep userData paths).
 *    Reserved basenames are now '_' prefixed and the basename is capped at ~120 chars.
 *
 * Run: node --test tests/unit/main/fixer-sessionend-flush-and-attachment-names.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Module } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

// ---------- Fix 1: session-end handler (source-pin, mirroring the maint/d26 pin style) ----------

test('fix1: main/index.js registers app.on("session-end") with a synchronous flushFiredNow in try/catch', () => {
  const src = read('src/main/index.js')
  // Handler registered
  assert.match(src, /app\.on\('session-end'/, 'session-end handler must be registered')
  // Extract the handler body and pin the synchronous flush call
  const m = src.match(/app\.on\('session-end', \(\) => \{([\s\S]*?)\}\)/)
  assert.ok(m, 'session-end handler body not found')
  const body = m[1]
  assert.match(body, /scheduler\.flushFiredNow\(\)/, 'handler must flush the scheduler watermark synchronously')
  assert.match(body, /try \{[\s\S]*flushFiredNow[\s\S]*\} catch/, 'flush must be guarded (best-effort, never blocks session end)')
  // No awaits / async work in the handler (session-end cannot run async reliably)
  assert.doesNotMatch(body, /\bawait\b|\.then\(|async/, 'handler must stay synchronous')
  // The known limits are documented: no renderer flush from main, sync-only contract
  assert.match(src, /session-end[\s\S]{0,900}renderer[\s\S]{0,900}CANNOT be flushed/, 'comment documents the renderer-flush limit')
  assert.match(src, /session-end[\s\S]{0,900}cannot[\s\S]{0,60}async/, 'comment documents the sync-only contract')
})

test('fix1: scheduler exports flushFiredNow (the session-end call site resolves)', () => {
  const src = read('src/main/scheduler.js')
  assert.match(src, /module\.exports = \{[\s\S]*flushFiredNow/, 'flushFiredNow must be exported')
})

// ---------- Fix 2: reserved device names + basename cap (behavior, electron mocked) ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-att-'))
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => TMP, isPackaged: false } }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require = createRequire(import.meta.url)
const attachments = require('../../../src/main/attachments.js')

const b64Of = s => Buffer.from(s, 'utf8').toString('base64')
const dir = path.join(TMP, 'files')

test('fix2: reserved device names are underscore-prefixed and land on disk', async () => {
  for (const name of ['con.png', 'NUL.txt', 'lpt1.pdf', 'Com7.mp3']) {
    const { key } = await attachments.saveAttachment({ taskId: 't-fix2', name, dataBase64: b64Of('x-' + name) })
    const stem = key.replace(/\.png$|\.txt$|\.pdf$|\.mp3$/, '').split('_')
    // key shape: <taskId>_<ts>_<displayName>; the display name must not be a reserved stem
    const display = key.split('_').slice(2).join('_')
    const base = display.replace(/\.[^.]+$/, '')
    assert.doesNotMatch(base, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i, `reserved name escaped sanitization: ${name} -> ${key}`)
    assert.ok(base.startsWith('_'), `reserved basename must be _ prefixed: ${name} -> ${key}`)
    void stem
    assert.ok(fs.existsSync(path.join(dir, key)), `file landed on disk: ${key}`)
  }
})

test('fix2: non-reserved names pass through unchanged (no collateral renaming)', async () => {
  const { key } = await attachments.saveAttachment({ taskId: 't-fix2b', name: 'conan.png', dataBase64: b64Of('ok') })
  assert.match(key, /_conan\.png$/, 'conan.png is not reserved and keeps its stem')
})

test('fix2: a 300-char basename is truncated to a <=120-char basename preserving the extension', async () => {
  const long = 'a'.repeat(300) + '.png'
  const { key } = await attachments.saveAttachment({ taskId: 't-fix2c', name: long, dataBase64: b64Of('long') })
  const display = key.split('_').slice(2).join('_')
  assert.ok(display.length <= 120, `display basename capped: got ${display.length}`)
  assert.ok(display.endsWith('.png'), 'extension preserved by the truncation')
  assert.ok(fs.existsSync(path.join(dir, key)), 'truncated file landed on disk')
})
