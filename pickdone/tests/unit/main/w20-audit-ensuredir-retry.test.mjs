/**
 * W20 (P3) — audit ensureDir failure retry semantics.
 *
 * The old ensureDir set dirReady=true unconditionally (even when mkdirSync threw), so ONE
 * transient mkdir failure (AV lock, permission blip) permanently killed the audit stream: every
 * later append short-circuited on the stale flag and appendFileSync into the nonexistent dir
 * failed both attempts, dropping every chunk forever. Now dirReady is only set on mkdir SUCCESS,
 * so a later flush against a healthy dir retries the mkdir and the trail recovers.
 *
 * Behavioral test drives the REAL module through setDirResolver: first resolve to a dir whose
 * mkdir must fail (path under a regular FILE → ENOTDIR), then repoint to a healthy dir and
 * assert the line lands. Under the old code the second flush dropped the line.
 *
 * Run: node --test tests/unit/main/w20-audit-ensuredir-retry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const audit = require('../../../src/main/audit.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w20-audit-'))
// A plain file: any mkdirSync(recursive) BELOW it fails with ENOTDIR regardless of platform.
const blocker = path.join(tmp, 'blocker-file')
fs.writeFileSync(blocker, 'x')
const deadDir = path.join(blocker, 'audit-never')
const goodDir = path.join(tmp, 'audit-ok')

test('W20: transient mkdir failure does not permanently kill the audit stream', () => {
  audit.resetForTests()
  // 1) flush against the un-mkdir-able dir — must not throw (fire-and-forget) and must not write
  audit.setDirResolver(() => deadDir)
  audit.recordCustom('w20.dead', { k: 1 })
  assert.doesNotThrow(() => audit.flushNow())
  assert.equal(fs.existsSync(deadDir), false, 'nothing written under the dead dir')

  // 2) repoint to a healthy dir — the trail must RECOVER (mkdir retried, line lands)
  audit.setDirResolver(() => goodDir)
  audit.recordCustom('w20.alive', { k: 2 })
  audit.flushNow()
  const file = path.join(goodDir, 'cli-audit.jsonl')
  assert.ok(fs.existsSync(file), 'audit file created after recovery')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(lines.some(l => l.includes('w20.alive')), 'recovery line landed on disk')
})

test('W20 source pin: dirReady is only set inside the try (success) path', async () => {
  const src = fs.promises ? await fs.promises.readFile(
    new URL('../../../src/main/audit.js', import.meta.url), 'utf8') : ''
  const fn = src.match(/function ensureDir \(\) \{[\s\S]*?\n\}/)[0]
  assert.ok(/try \{[\s\S]*dirReady = true[\s\S]*\} catch/.test(fn),
    'dirReady = true must live inside the try block')
  assert.doesNotMatch(fn, /catch[\s\S]*\}[\s\S]*dirReady = true/,
    'no dirReady = true may follow the catch block')
  audit.resetForTests()
})
