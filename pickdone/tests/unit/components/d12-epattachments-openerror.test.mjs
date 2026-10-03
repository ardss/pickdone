/**
 * Fault-7 renderer twin (D12 2026-10-01): EpAttachments.openFileUrl must surface the structured
 * { ok:false, error } result the main handler now returns when shell.openPath fails — the old
 * code only handled {missing:true} and silently did nothing on an OS open refusal.
 *
 * Run: node --test tests/unit/components/d12-epattachments-openerror.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SRC = 'renderer/js/components/edit-panel/EpAttachments.vue'

async function loadComponent () {
  const src = readFileSync(path.join(ROOT, SRC), 'utf8')
  const m = src.match(/<script lang="ts">([\s\S]*?)<\/script>/)
  assert.ok(m, 'script block found')
  let js = m[1].replace(/ as (any|HTMLElement)\b/g, '')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'd12-ep-att-'))
  writeFileSync(path.join(dir, 'logger-stub.mjs'), `
const calls = []
export const logger = {
  info: () => {}, warn: () => {},
  error: (msg, stack) => { calls.push(String(msg)) },
  flush: () => {}
}
export const __calls = calls
`)
  js = js.replace("from '../../utils/logger.js'", "from './logger-stub.mjs'")
  // Every remaining RELATIVE import must resolve against the real renderer tree: the script text
  // is executed from a temp copy, so any '../../x.js' left in place silently resolves against
  // os.tmpdir()'s parent and dies with ERR_MODULE_NOT_FOUND (this broke when EpAttachments grew
  // its second import, core.js's isRenderableAttachmentUrl). Rewriting the whole class — not one
  // specifier — keeps the harness immune to future imports.
  js = js.replace(/from '((?:\.\.\/)+[^']+)'/g,
    (_, rel) => `from '${pathToFileURL(path.join(ROOT, 'renderer/js/components/edit-panel', rel)).href}'`)
  const modPath = path.join(dir, 'component.mjs')
  writeFileSync(modPath, js)
  // The relative rewrite now pulls in real renderer modules (core.js → i18n) that touch `window`
  // at module load, so the shell stub must exist BEFORE the import — per-test todoAPI/ElementPlus
  // still override afterwards (tests assign onto the same object).
  globalThis.window = globalThis.window || { location: { hash: '' } }
  globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null, setItem: () => {}, removeItem: () => {}
  }
  const stub = await import(pathToFileURL(path.join(dir, 'logger-stub.mjs')).href)
  const mod = await import(pathToFileURL(modPath).href)
  return { comp: mod.default, calls: stub.__calls }
}

test('openFileUrl surfaces a structured {error} result: toast + renderer log', async () => {
  const { comp, calls } = await loadComponent()
  const toasts = []
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = { openFile: () => Promise.resolve({ ok: false, error: 'no association', name: 'a.txt' }) }
  globalThis.window.ElementPlus = { ElMessage: opts => toasts.push(opts) }
  const before = calls.length
  comp.methods.openFileUrl.call({ $t: k => k }, { url: 'local://a.txt' })
  await new Promise(r => setTimeout(r, 50))
  // red before the fix: the then-branch only knew {missing:true} and dropped {error}
  assert.equal(toasts.length, 1, 'an OS open refusal must reach the user')
  assert.equal(toasts[0].type, 'error')
  assert.match(toasts[0].message, /no association/)
  assert.ok(calls.length > before, 'the failure must reach the renderer logger')
  assert.match(calls[calls.length - 1], /open-file failed/)
})

test('openFileUrl stays silent when the open succeeds (plain true)', async () => {
  const { comp, calls } = await loadComponent()
  const toasts = []
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = { openFile: () => Promise.resolve(true) }
  globalThis.window.ElementPlus = { ElMessage: opts => toasts.push(opts) }
  const before = calls.length
  comp.methods.openFileUrl.call({ $t: k => k }, { url: 'local://a.txt' })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(toasts.length, 0)
  assert.equal(calls.length, before)
})
