/** Missing-file guard (feature: LAN-synced attachments — metadata rows arrive before the
 * file is pulled): open-file / download-file-and-open / save-upload-file-to-download all
 * return a structured {missing:true, name} result for a local:// url whose file is absent,
 * instead of silently "succeeding" or throwing a raw ENOENT. Present files keep the old
 * behavior (open → true / copied path).
 * Run: node --test tests/unit/main/att-missing-guard.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Module } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

test('attachment handlers: absent local:// files answer a structured missing result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'att-guard-'))
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir }, dialog: {}, shell: { openPath: () => { opened = true; return '' }, openExternal: async () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  let opened = false
  try {
    const mod = require('../../../src/main/handlers/attachments.js')
    const h = mod({ isLocked: () => false, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
    const url = 'local://' + encodeURIComponent('present.png')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'files', 'present.png'), 'x') // attachDir() = <userData>/files
    // present file: old behavior preserved
    assert.equal(await h['open-file']({}, url), true)
    assert.equal(opened, true)
    // absent file: structured missing result on all three channels
    for (const [ch, args] of [['open-file', [url.replace('present', 'absent')]], ['download-file-and-open', [url.replace('present', 'absent')]], ['save-upload-file-to-download', [url.replace('present', 'absent'), 'a.png']]]) {
      const r = await h[ch]({}, ...args)
      assert.ok(r && r.missing === true, ch + ' must report missing')
      assert.equal(r.name, 'absent.png')
    }
  } finally {
    Module._load = origLoad
    rmSync(dir, { recursive: true, force: true })
  }
})
