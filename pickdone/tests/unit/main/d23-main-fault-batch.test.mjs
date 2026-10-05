// Fix-round d23 (2026-10-06) main-process fault batch:
//   - i18n: a transient config read failure must not lock the session locale (retry next call)
//   - dbRecovery.preflightMigrateResidue: orphaned todos-encrypted.tmp is renamed aside after
//     the plain-bak restore
//   - windows.js render-process-gone: source-pin for the stale-window wcAtCrash capture
//   - handlers/attachments.js open-file: source-pin for the openExternalSafely routing
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const Module = require('module')
import { fileURLToPath } from 'node:url'
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ---------- i18n: transient read failure must not cache the fallback ----------

test('i18n currentLocale: read failure is not cached, next call retries the config', () => {
  // Fresh module registry per test: i18n caches per-module; stub 'electron' + 'fs' readFileSync
  // to throw a transient EPERM on the FIRST config read only.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-d23-'))
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ appLocale: 'en-US' }))
  const stubs = {
    electron: { app: { getPath: k => (k === 'userData' ? TMP : path.join(TMP, k)), getLocale: () => 'zh-CN' } },
  }
  let failNextRead = true
  const origLoad = Module._load
  const origReadFileSync = fs.readFileSync
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  fs.readFileSync = function (...args) {
    if (failNextRead && String(args[0]).endsWith('config.json')) {
      failNextRead = false
      const e = new Error('transient lock'); e.code = 'EPERM'; throw e
    }
    return origReadFileSync.apply(fs, args)
  }
  try {
    delete require.cache[require.resolve('../../../src/main/i18n.js')]
    const i18n = require('../../../src/main/i18n.js')
    // First call: transient EPERM -> falls back to system default (zh-CN) WITHOUT caching
    assert.equal(i18n.currentLocale(), 'zh-CN')
    // Second call: the read now succeeds -> the STORED locale applies (old code stayed zh-CN forever)
    assert.equal(i18n.currentLocale(), 'en-US')
  } finally {
    fs.readFileSync = origReadFileSync
    Module._load = origLoad
    delete require.cache[require.resolve('../../../src/main/i18n.js')]
    fs.rmSync(TMP, { recursive: true, force: true })
  }
})

test('i18n currentLocale: genuinely absent config caches the system default', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-d23-absent-'))
  const stubs = {
    electron: { app: { getPath: k => (k === 'userData' ? TMP : path.join(TMP, k)), getLocale: () => 'zh-CN' } },
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('../../../src/main/i18n.js')]
    const i18n = require('../../../src/main/i18n.js')
    assert.equal(i18n.currentLocale(), 'zh-CN') // ENOENT -> stable fallback, cacheable
    assert.equal(i18n.currentLocale(), 'zh-CN')
  } finally {
    Module._load = origLoad
    delete require.cache[require.resolve('../../../src/main/i18n.js')]
    fs.rmSync(TMP, { recursive: true, force: true })
  }
})

// ---------- dbRecovery: orphaned todos-encrypted.tmp swept after plain-bak restore ----------

test('preflightMigrateResidue: crash-between-renames tmp is renamed aside on plain-bak restore', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'd23-recovery-'))
  try {
    // Scene: todos.db absent, plain-bak present, no db.key, plus the fully-written migration tmp.
    fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'PLAINSQL-backup-bytes-not-a-real-header-but-preflight-does-not-check')
    fs.writeFileSync(path.join(ud, 'todos-encrypted.tmp'), 'ENCRYPTED-db-bytes')
    const { preflightMigrateResidue } = require('../../../src/main/dbRecovery.cjs')
    const ok = preflightMigrateResidue(ud, { warn: () => {} })
    assert.equal(ok, true)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')), 'plain-bak restored to todos.db')
    assert.ok(!fs.existsSync(path.join(ud, 'todos-encrypted.tmp')), 'tmp no longer occupies its name')
    const stale = fs.readdirSync(ud).find(f => f.startsWith('todos-encrypted.tmp.stale-'))
    assert.ok(stale, 'tmp renamed aside (not deleted) for forensics')
    assert.equal(fs.readFileSync(path.join(ud, stale), 'utf8'), 'ENCRYPTED-db-bytes')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('preflightMigrateResidue: no tmp present -> restore succeeds without sweep side effects', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'd23-recovery2-'))
  try {
    fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'PLAINSQL')
    const { preflightMigrateResidue } = require('../../../src/main/dbRecovery.cjs')
    assert.equal(preflightMigrateResidue(ud, { warn: () => {} }), true)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('todos-encrypted')).length, 0)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

// ---------- source pins: stale-window crash reload + openExternal routing ----------

test('windows.js: render-process-gone reload captures webContents before the timer', () => {
  const src = readFileSync(path.join(REPO, 'src', 'main', 'windows.js'), 'utf8')
  const goneIdx = src.indexOf("on('render-process-gone'")
  assert.ok(goneIdx > 0)
  const block = src.slice(goneIdx, src.indexOf("on('did-finish-load'") > goneIdx ? src.indexOf("on('did-finish-load'") : src.length)
  // The reload timer must NOT resolve getMainWindow() at fire time...
  assert.ok(!/setTimeout\(\(\) => \{ const w = getMainWindow\(\)/.test(block), 'stale getMainWindow() at fire time removed')
  // ...and must capture + verify the exact webContents (parity with did-fail-load's wcAtFail)
  assert.match(block, /const wcAtCrash = win\.webContents/)
  assert.match(block, /win\.webContents === wcAtCrash && !wcAtCrash\.isDestroyed\(\)/)
  assert.match(block, /wcAtCrash\.reload\(\)/)
})

test('handlers/attachments.js: open-file routes external urls through openExternalSafely', () => {
  const src = readFileSync(path.join(REPO, 'src', 'main', 'handlers', 'attachments.js'), 'utf8')
  assert.ok(!/return shell\.openExternal\(url\)/.test(src), 'fire-and-forget openExternal removed')
  assert.match(src, /openExternalSafely\(shell, url\)/)
})
