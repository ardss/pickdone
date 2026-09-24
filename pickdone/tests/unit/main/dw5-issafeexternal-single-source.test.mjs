/**
 * dw wave5 P3 — isSafeExternal single source. handlers/system.js used to carry a private
 * verbatim copy of index.js's isSafeExternal instead of consuming the injected ctx one; any
 * future drift would split the external-link safety criterion between two files.
 * Run: node --test tests/unit/main/dw5-issafeexternal-single-source.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const code = p => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

test('P3: system.js consumes the ctx-injected isSafeExternal; no local copy remains', () => {
  const src = code('src/main/handlers/system.js')
  assert.match(src, /isSafeExternal\s*}\s*=\s*ctx/, 'isSafeExternal is destructured from ctx like isLocked')
  assert.doesNotMatch(src, /function isSafeExternal/, 'the private local copy is gone')
})

test('P3: behavior unchanged — open-external-url still opens only http(s) and stays locked-gated', () => {
  // Load the handler module with a minimal ctx + electron stub
  const require_ = createRequire(import.meta.url)
  const opened = []
  const electronStub = {
    Notification: function Notification (o) { this.show = () => {} },
    shell: { openExternal: u => opened.push(u), openPath: () => {} }
  }
  const Module = require_('module')
  const resolved = require_.resolve(path.join(ROOT, 'src/main/handlers/system.js'))
  delete require_.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    if (request === 'electron-log') return { warn: () => {}, scope: () => {} }
    if (request === '../export-xlsx') return { createExporter: () => ({ exportTodosToXlsx: () => {} }) }
    if (request === './shared') return { makeAssertMainWindow: () => () => {} }
    if (request === '../updater') return { check: () => {}, downloadUpdate: () => {}, quitAndInstall: () => {}, getStatus: () => ({}) }
    if (request === '../fix-util') return { formatLogLines: a => a.join('\n') }
    return origLoad.call(this, request, parent, isMain)
  }
  let handlers
  try {
    handlers = require_(resolved)({
      isLocked: () => false,
      allowWithinRate: () => true,
      i18n: { mt: k => k },
      app: { getPath: () => process.cwd() },
      getMainWindow: () => null,
      isSafeExternal: u => typeof u === 'string' && /^https?:\/\//i.test(u) // the ctx copy (index.js shape)
    })
  } finally { Module._load = origLoad }
  const sender = { sender: { id: 1 } }
  handlers['open-external-url'](sender, 'https://example.com')
  handlers['open-external-url'](sender, 'file:///C:/Windows/System32/calc.exe')
  handlers['open-external-url'](sender, 'javascript:alert(1)')
  assert.deepEqual(opened, ['https://example.com'], 'only http(s) reaches shell.openExternal')
})

test('P3: locked gate still throws before opening', () => {
  const src = code('src/main/handlers/system.js')
  const idx = src.indexOf("'open-external-url'")
  const body = src.slice(idx, src.indexOf("'export-todos-to-xlsx'"))
  assert.ok(body.indexOf('isLocked()') < body.indexOf('isSafeExternal'), 'the lock gate precedes the open')
})
