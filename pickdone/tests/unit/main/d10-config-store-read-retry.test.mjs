/** D10 (2026-09-27): config-store quarantined ANY non-ENOENT read error — an AV scan / EBUSY lock
 *  on a perfectly good config.json renamed it to .bad immediately, and the next writeConfig
 *  persisted an amputated defaults object. Transient IO codes now retry with a short backoff
 *  before quarantining; only definitive corruption (JSON parse error) quarantines immediately.
 * Run: node --test tests/unit/main/d10-config-store-read-retry.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cfg = require('../../../src/main/config-store.js')

function withDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd10-cfg-'))
  cfg.__setConfigDir(dir)
  return dir
}

test('d10: EBUSY on a healthy config retries and succeeds — NO .bad quarantine, config intact', () => {
  const dir = withDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ locale: 'en', winBounds: { width: 900 } }), 'utf8')
  let attempts = 0
  const origRead = fs.readFileSync
  fs.readFileSync = (p, enc) => {
    if (String(p).endsWith('config.json') && ++attempts <= 2) {
      const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'
      throw e
    }
    return origRead(p, enc)
  }
  try {
    const c = cfg.readConfig()
    assert.equal(c.locale, 'en', 'third attempt reads the healthy config (red before the fix: quarantined on first EBUSY)')
    assert.equal(cfg.isReadFailed(), false)
    assert.ok(!fs.existsSync(path.join(dir, 'config.json.bad')), 'a perfectly good config.json was never renamed aside')
  } finally { fs.readFileSync = origRead }
})

test('d10: a JSON parse error still quarantines immediately (definitive corruption)', () => {
  const dir = withDir()
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json', 'utf8')
  const c = cfg.readConfig()
  assert.deepEqual(Object.keys(c), ['shortcutKeySettings'], 'defaults returned')
  assert.ok(fs.existsSync(path.join(dir, 'config.json.bad')), 'corrupt content is still preserved in .bad')
})
