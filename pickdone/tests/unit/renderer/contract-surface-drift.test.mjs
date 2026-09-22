/**
 * Sharp-review round (2026-09-22) — [renderer-4] contracts.d.ts surface drift guard.
 * contracts.d.ts claims SSOT for the renderer's window-injection face, but it had drifted: 8+ members
 * exposed by preload and actually called by the renderer were absent from TodoAPI, the Window interface
 * lacked `commands`, and the DbCallOp union lagged src/main's ALLOWED_RENDERER_OPS whitelist. Typecheck
 * stayed green only because callers are loose .js — this mirror test makes the drift red instead.
 * Run: node --test tests/unit/renderer/contract-surface-drift.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const preload = read('src/preload/index.js')
const contracts = read('renderer/js/contracts.d.ts')
const todoHandlers = read('src/main/handlers/todo.js')

test('every key of preload\'s exposed todoAPI object is declared in contracts.d.ts', () => {
  const m = preload.match(/exposeInMainWorld\(\s*['"]todoAPI['"]\s*,\s*\{([\s\S]*?)\n\}\)/)
  assert.ok(m, 'preload exposes a todoAPI object literal')
  const keys = [...m[1].matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(x => x[1])
  assert.ok(keys.length > 50, 'sanity: preload key parse non-trivial (' + keys.length + ' keys)')
  const missing = keys.filter(k => !contracts.includes(k))
  assert.deepEqual(missing, [], 'TodoAPI contract missing preload-exposed members')
})

test('DbCallOp union mirrors src/main ALLOWED_RENDERER_OPS exactly (both directions)', () => {
  const wl = todoHandlers.match(/ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(wl, 'whitelist found in src/main/handlers/todo.js')
  const ops = [...new Set([...wl[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(x => x[1]))]
  const dt = contracts.match(/type DbCallOp = ([^\n]*)/)
  assert.ok(dt, 'DbCallOp union found in contracts.d.ts')
  for (const op of ops) {
    assert.ok(dt[1].includes("'" + op + "'"), `DbCallOp is missing whitelisted op '${op}'`)
  }
  const declared = [...dt[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(x => x[1])
  const extra = declared.filter(op => !ops.includes(op))
  assert.deepEqual(extra, [], 'DbCallOp declares ops absent from the whitelist (stale mirror)')
})

test('Window interface declares the commands bridge (commit + commitBatch)', () => {
  const win = contracts.match(/interface Window \{([\s\S]*?)\n\}/)
  assert.ok(win, 'Window interface found')
  assert.ok(win[1].includes('commands'), 'Window.commands declared')
  const m = preload.match(/exposeInMainWorld\('commands',\s*\{([\s\S]*?)\n\}\)/)
  assert.ok(m, 'preload exposes window.commands')
  for (const fn of ['commit', 'commitBatch']) {
    assert.ok(m[1].includes(fn + ':'), `preload commands.${fn} present`)
    assert.ok(win[1].includes(fn), `Window.commands.${fn} declared in contracts`)
  }
})
