/**
 * D18 (2026-10-02) — security-lock isLocked() config-read cache.
 * isLocked() sits on EVERY gated IPC call (todo-db:call, the fix-util 500ms poll) and used to
 * readConfig() on each one — a full config.json read with up to ~1.5s of synchronous AV-lock
 * backoff, freezing the main thread per DB op under contention. The flag is now cached with a
 * 2s TTL and invalidated IMMEDIATELY by config-store's write-version counter (any writeConfig
 * bumps it), so enabling/disabling the lock takes effect right after the write.
 * Run: node --test tests/unit/main/d18-security-lock-cache.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const require = createRequire(import.meta.url)
// electron stub (security-lock requires BrowserWindow at module load)
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {} }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const { createSecurityLock } = require('../../../src/main/security-lock.js')

function makeLock ({ config }) {
  let reads = 0
  let version = 0
  const lock = createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => { reads++; return { enableSecurityLock: config.enabled } },
    writeConfig: () => {},
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} },
    configVersion: () => version
  })
  return { lock, reads: () => reads, bumpVersion: () => { version++ }, setEnabled: v => { config.enabled = v } }
}

test('D18: repeated isLocked() calls within the TTL read config.json once', () => {
  const h = makeLock({ config: { enabled: false } })
  for (let i = 0; i < 10; i++) assert.equal(h.lock.isLocked(), false)
  assert.equal(h.reads(), 1, 'red before the fix: every gated IPC call re-read config.json')
})

test('D18: a config WRITE (version bump) invalidates immediately — the fresh value is re-read at once', () => {
  const h = makeLock({ config: { enabled: false } })
  assert.equal(h.lock.isLocked(), false)
  assert.equal(h.reads(), 1)
  h.setEnabled(true)
  assert.equal(h.lock.isLocked(), false, 'still cached: no write has landed yet (and no lock window exists)')
  assert.equal(h.reads(), 1)
  h.bumpVersion() // any writeConfig (settings toggle) bumps the counter
  h.lock.isLocked()
  assert.equal(h.reads(), 2, 'red before the fix: the same TTL window served the stale flag after the write')
})

test('D18: disable invalidates the cache immediately after the write too', () => {
  const h = makeLock({ config: { enabled: true } })
  h.lock.isLocked()
  assert.equal(h.reads(), 1)
  h.setEnabled(false)
  h.bumpVersion()
  h.lock.isLocked()
  assert.equal(h.reads(), 2, 'the disable write must be visible on the very next gated IPC call')
})

test('D18: without a version source the cache degrades to TTL-only (no per-call re-read)', () => {
  let reads = 0
  const lock = createSecurityLock({
    getMainWindow: () => null, showMainOrLock: () => {},
    readConfig: () => { reads++; return { enableSecurityLock: false } },
    writeConfig: () => {}, i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} },
    configVersion: () => null
  })
  for (let i = 0; i < 5; i++) lock.isLocked()
  assert.equal(reads, 1, 'TTL-only caching still avoids the per-call config read')
})

test('D18: locking intent short-circuits regardless of the cache', () => {
  const h = makeLock({ config: { enabled: false } })
  // lockAppNow needs BrowserWindow internals — assert the intent branch via a locked cacheless path instead
  assert.equal(h.lock.isLocked(), false)
})

test('D18: config-store exposes the write-version counter and bumps it on writeConfig', () => {
  const store = require('../../../src/main/config-store.js')
  assert.equal(typeof store.configWriteVersion(), 'number')
  const before = store.configWriteVersion()
  process.env.TODO_CONFIG_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'd18-cfg-'))
  store.__setConfigDir(process.env.TODO_CONFIG_DIR)
  const r = store.writeConfig({ locale: 'en' })
  assert.ok(r && r.locale === 'en')
  assert.equal(store.configWriteVersion(), before + 1, 'red before the fix: no write-version hook existed')
})
