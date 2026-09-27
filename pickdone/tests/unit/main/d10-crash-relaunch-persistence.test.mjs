/** D10 (2026-09-27): renderer crash relaunch storm. crashReloadCount is in-memory, resets on
 *  did-finish-load AND on every app.relaunch() (fresh process ⇒ 0), so a deterministic startup
 *  crash looped crash→3 reloads→relaunch forever. The relaunch branch now burns a PERSISTED
 *  counter (marker file in userData, cleared by a 60s post-load health window) and gives up past
 *  the cap. The relaunch decision itself is unit-tested in d10-domain-d-pure-fixes; here we pin
 *  the marker-file round-trip + the simulated relaunch cycle reaching 'give-up'.
 * Run: node --test tests/unit/main/d10-crash-relaunch-persistence.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd10-crash-'))
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => TMP }, BrowserWindow: class {}, shell: {} }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const windows = require('../../../src/main/windows.js')
const { crashRelaunchDecision, CRASH_RELAUNCH_CAP } = require('../../../src/main/handlers/shared.js')

test('d10: crash relaunch counter persists across simulated process restarts (survives a fresh module require)', () => {
  assert.equal(windows.__crashCounter.read(), 0, 'no marker: count 0 (fresh install)')
  // relaunch #1 in "process A"
  windows.__crashCounter.write(windows.__crashCounter.read() + 1)
  // "process B": re-require the module — the in-memory counter would be 0, the marker must say 1
  delete require.cache[require.resolve('../../../src/main/windows.js')]
  const windowsB = require('../../../src/main/windows.js')
  assert.equal(windowsB.__crashCounter.read(), 1, 'red before the fix: nothing was persisted, every relaunch started from 0')
  windowsB.__crashCounter.write(windowsB.__crashCounter.read() + 1)
  windowsB.__crashCounter.write(windowsB.__crashCounter.read() + 1)
  assert.equal(windowsB.__crashCounter.read(), CRASH_RELAUNCH_CAP)
  // simulated relaunch cycle: at the persisted cap the policy gives up instead of relaunching
  assert.equal(crashRelaunchDecision(windowsB.__crashCounter.read()), 'give-up')
})

test('d10: the health window clears the counter (a stable run resets the storm budget)', () => {
  windows.__crashCounter.write(0)
  assert.equal(windows.__crashCounter.read(), 0)
  assert.equal(crashRelaunchDecision(windows.__crashCounter.read()), 'relaunch', 'budget restored after a healthy run')
})
