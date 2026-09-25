/**
 * Regression: EpAttachments.openFileUrl swallowed invoke-level failures.
 *
 * The old code ended with `.catch(() => {})` whose comment claimed invoke-level
 * errors "keep their existing reporting path" — but an explicit catch PREVENTS the
 * global unhandledrejection capture (renderer/js/utils/logger.js
 * installGlobalErrorCapture) from firing, so a rejected `open-file` invoke (e.g. the
 * locked gate in src/main/handlers/attachments.js) vanished without any log or toast.
 *
 * Fix: route the rejection to the renderer logger explicitly.
 *
 * Run: node --test tests/unit/components/ep-attachments-openfile-invoke-error.test.mjs
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

/** Extract the <script lang="ts"> body and strip the few TS casts it uses. */
async function loadComponent () {
  const src = readFileSync(path.join(ROOT, SRC), 'utf8')
  const m = src.match(/<script lang="ts">([\s\S]*?)<\/script>/)
  assert.ok(m, 'script block found')
  let js = m[1].replace(/ as (any|HTMLElement)\b/g, '')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ep-att-openfile-'))
  // Recording stub swapped in for the real logger via the import specifier.
  writeFileSync(path.join(dir, 'logger-stub.mjs'), `
const calls = []
export const logger = {
  info: () => {}, warn: () => {},
  error: (msg, stack) => { calls.push({ level: 'error', msg: String(msg), stack: stack ? String(stack) : '' }) },
  flush: () => {}
}
export const __calls = calls
`)
  js = js.replace("from '../../utils/logger.js'", "from './logger-stub.mjs'")
  const modPath = path.join(dir, 'component.mjs')
  writeFileSync(modPath, js)
  const stub = await import(pathToFileURL(path.join(dir, 'logger-stub.mjs')).href)
  const mod = await import(pathToFileURL(modPath).href)
  return { comp: mod.default, calls: stub.__calls }
}

test('openFileUrl logs an invoke-level rejection instead of swallowing it', async () => {
  const { comp, calls } = await loadComponent()
  const before = calls.length
  // Simulate the main-process 'open-file' locked gate rejecting the invoke.
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = { openFile: () => Promise.reject(new Error('locked')) }
  comp.methods.openFileUrl.call({ $t: k => k }, { url: 'local://abc' })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('rejection was never logged')), 1000)
    setTimeout(() => { clearTimeout(t); resolve() }, 50)
  })
  const logged = calls.slice(before)
  assert.ok(logged.length >= 1, 'invoke-level failure must reach the renderer logger')
  assert.match(logged[0].msg, /open-file invoke failed/)
  assert.match(logged[0].msg, /locked/)
})

test('openFileUrl keeps the missing-file warning toast for structured {missing:true} results', async () => {
  const { comp, calls } = await loadComponent()
  const toasts = []
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = { openFile: () => Promise.resolve({ missing: true, name: 'a.txt' }) }
  globalThis.window.ElementPlus = { ElMessage: opts => toasts.push(opts) }
  const before = calls.length
  comp.methods.openFileUrl.call({ $t: k => k }, { url: 'local://gone' })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(toasts.length, 1, 'missing-file toast preserved')
  assert.equal(toasts[0].type, 'warning')
  assert.equal(calls.length, before, 'structured missing result must NOT be logged as an error')
})
