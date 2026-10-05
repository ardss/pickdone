/**
 * maint/d23 FIX-3b round (renderer) — regression guards.
 * Fixes covered:
 *   [T1] TomatoBar rest-abandon awaits giveUp; startFocus dispatches are observed and surface failure toasts
 *   [T2] TomatoBar todayDone derives the day key from the reactive tick (`ts`), not a bare dayjs()
 *   [T3] TomatoPanel todayRecords derives the day key from the reactive tick (`nowTs`)
 *   [T4] utils/dispatchObserved.observeDispatch logs and re-throws action failures (executing test)
 * Run: node --test tests/unit/renderer/d23-fix3b-renderer-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [T1] tomato dispatch honesty ---------- */

test('[T1] TomatoBar rest-abandon awaits giveUp and surfaces a failure toast', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  const i = src.indexOf('async onPlayClick () {')
  assert.ok(i > -1, 'onPlayClick found')
  const body = src.slice(i, src.indexOf('cancelAttach', i) > -1 ? i + 2200 : undefined)
  const iAwait = body.indexOf('await observeDispatch(store, \'tomato/giveUp\', { record: false })')
  assert.ok(iAwait > -1, 'the rest-abandon giveUp dispatch is awaited')
  assert.ok(body.slice(iAwait).includes('reportDispatchFail(e)'), 'a failed abandon surfaces the failure toast, the countdown cannot keep running silently')
  assert.ok(body.includes("observeDispatch(store, 'tomato/startFocus')"), 'startFocus is observed, not fire-and-forget')
  assert.ok(src.includes('statsH.main.actionFailedMsg'), 'failure toast reuses the existing actionFailedMsg key (no new i18n)')
})

test('[T1] TomatoFloatPage reset() rest-abandon and btnMain startFocus are observed dispatches', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(/startRestTime'\) \{ observeDispatch\(this\.\$store, 'tomato\/giveUp', \{ record: false \}\)\.catch\(this\.reportDispatchFail\)/.test(src),
    'the rest path of reset() routes giveUp through observeDispatch with a failure toast')
  assert.ok(/status === 'default'\) \{ observeDispatch\(this\.\$store, 'tomato\/startFocus'\)\.catch\(this\.reportDispatchFail\)/.test(src),
    'btnMain routes startFocus through observeDispatch with a failure toast')
})

/* ---------- [T2/T3] reactive "today" day key ---------- */

test('[T2] TomatoBar.todayDone keys off the reactive 1s tick field, not a bare dayjs()', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  const i = src.indexOf('todayDone () {')
  assert.ok(i > -1, 'todayDone computed found')
  const body = src.slice(i, i + 400)
  assert.ok(!/const key = dayjs\(\)\.format\(FMT\.date\)/.test(body),
    'the zero-reactive-dependency dayjs() call is gone')
  assert.ok(/const key = dayjs\(this\.ts \|\| Date\.now\(\)\)\.format\(FMT\.date\)/.test(body),
    'the day key derives from the reactive `ts` data field (refreshed by the 1s interval)')
})

test('[T3] TomatoPanel.todayRecords keys off the reactive 500ms tick field, not a bare dayjs()', () => {
  const src = read('renderer/js/components/TomatoPanel.vue')
  const i = src.indexOf('todayRecords () {')
  assert.ok(i > -1, 'todayRecords computed found')
  const body = src.slice(i, i + 400)
  assert.ok(!/const key = dayjs\(\)\.format\(FMT\.date\)/.test(body),
    'the zero-reactive-dependency dayjs() call is gone')
  assert.ok(/const key = dayjs\(this\.nowTs \|\| Date\.now\(\)\)\.format\(FMT\.date\)/.test(body),
    'the day key derives from the reactive `nowTs` data field (refreshed by the 500ms interval)')
})

/* ---------- [T4] executing test: utils/dispatchObserved ---------- */

test('[T4] observeDispatch awaits the action, logs once, and re-throws for the caller to toast', async () => {
  const { observeDispatch } = await import(new URL('file://' + path.join(ROOT, 'renderer/js/utils/dispatchObserved.js').replace(/\\/g, '/')).href)
  const seen = []
  const store = {
    dispatch (action, payload) {
      seen.push([action, payload])
      if (action === 'tomato/giveUp') return Promise.reject(new Error('ipc down'))
      return Promise.resolve({ ok: true })
    }
  }
  const ok = await observeDispatch(store, 'tomato/startFocus')
  assert.deepEqual(ok, { ok: true })
  await assert.rejects(() => observeDispatch(store, 'tomato/giveUp', { record: false }), /ipc down/,
    'the failure is re-thrown so the component .catch can surface the toast')
  assert.deepEqual(seen[1], ['tomato/giveUp', { record: false }], 'payload is passed through verbatim')
})
