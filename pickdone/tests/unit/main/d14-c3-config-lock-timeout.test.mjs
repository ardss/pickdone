/* D14 C3 regression — a sustained transient lock (AV scan) on a HEALTHY config.json no longer
 * quarantines it. The old D10 budget (3 reads, ~150ms) sat far below real AV on-access lock
 * durations, and exhausting it renamed the healthy file to .bad. Now the retry budget scales
 * (5 attempts, ~1.5s exponential backoff) and a lock TIMEOUT is treated as contention — the
 * read-failed WRITE gate engages (no clobber of the still-locked file), quarantine stays
 * reserved for definitive corruption (JSON parse error). Run:
 * node --test tests/unit/main/d14-c3-config-lock-timeout.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const cfg = require_('../../../src/main/config-store.js')

test('C3: sustained EBUSY on a healthy config.json does NOT quarantine it — write gate only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd14-c3-'))
  cfg.__setConfigDir(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ locale: 'zh', winBounds: { width: 800 } }), 'utf8')
  const origRead = fs.readFileSync
  fs.readFileSync = (p, enc) => {
    if (String(p).endsWith('config.json')) {
      const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'
      throw e
    }
    return origRead(p, enc)
  }
  try {
    const c = cfg.readConfig()
    assert.deepEqual(Object.keys(c), ['shortcutKeySettings'], 'defaults returned for the session')
    assert.ok(!fs.existsSync(path.join(dir, 'config.json.bad')), 'a lock TIMEOUT is not corruption: the healthy file was never renamed aside (red before the fix: quarantined after ~150ms)')
    assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'config.json still in place')
    assert.equal(cfg.isReadFailed(), true, 'writes gated off so the on-disk config cannot be clobbered')
    // a later successful read clears the gate and reads the INTACT config
    fs.readFileSync = origRead
    const c2 = cfg.readConfig()
    assert.equal(c2.locale, 'zh', 'real config survives the sustained lock')
    assert.equal(cfg.isReadFailed(), false)
  } finally { fs.readFileSync = origRead }
})
