/* QC sweep 2026-10-09 — timer-lifecycle + log-isolation + quit-abort + renderer guards.
 * Fixes pinned here (all lifecycle/log-ordering wiring → source-scan pins, plus one
 * behavioral aux-load-guard timer test following the dw3 harness shape):
 *   1. quitFromTrayInner: dialog failure aborts the quit (same semantics as cancel) instead
 *      of falling through to app.quit() and killing a live pomodoro.
 *   2. aux-load-guard: the backoff retry timer is tracked and cleared on 'closed'/'did-finish-load'
 *      (D21 timer-lifecycle parity with windows.js).
 *   3. windows.js: the render-process-gone 300ms crash-reload timer is tracked and cleared in
 *      the 'closed' handler alongside _resizeTimer/crashHealthTimer/loadRetryTimer.
 *   4. command-bus runHooks: log-isolation require is warn-path only (inside the catch), not
 *      once per hook of every commit.
 *   5. renderer CLI tomato start: giveUp is awaited before startFocus (phase-guard sequencing).
 *   6. renderer cross-window settings: only STRICTLY older _lsAt packets are dropped; equal
 *      stamps fall through to the per-key content diff (same-millisecond write loss fixed).
 * Run: node --test tests/unit/main/qc-1009-lifecycle-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const readMain = rel => fs.readFileSync(path.join(root, 'src/main', rel), 'utf8')
const readRenderer = rel => fs.readFileSync(path.join(root, rel), 'utf8')

/* ---------- 1. quitFromTray dialog failure aborts the quit ---------- */

test('QC1: quitFromTrayInner catch aborts the quit and restores quitByUser (dialog failure == cancel)', () => {
  const src = readMain('index.js')
  const i = src.indexOf('async function quitFromTrayInner')
  const body = src.slice(i, src.indexOf('function rebuildTrayMenu'))
  const catchIdx = body.indexOf('} catch (e) {')
  assert.ok(catchIdx > 0, 'confirm-dialog try/catch exists')
  const catchBody = body.slice(catchIdx, body.indexOf('\n  }', catchIdx))
  // the abort must restore the committed quit intent BEFORE anything below can run
  assert.match(catchBody, /state\.quitByUser = false/, 'quitByUser restored')
  assert.match(catchBody, /return/, 'quit aborted (no fall-through to destroy/quit)')
  // the old "proceeding with quit" semantics must be gone
  assert.doesNotMatch(catchBody, /proceeding with quit/, 'silent-proceed catch removed')
  // structural: the catch return sits BEFORE the tray destroy / app.quit chain
  assert.ok(catchIdx < body.indexOf('app.quit()'), 'abort happens before app.quit()')
})

/* ---------- 2. aux-load-guard retry timer lifecycle ---------- */

// Minimal fake window (same shape as the dw3 harness FakeBrowserWindow).
function makeFakeWin () {
  const listeners = {}
  const wc = {
    on: (ev, fn) => { (listeners['wc:' + ev] = listeners['wc:' + ev] || []).push(fn) },
    emit: (ev, ...a) => { for (const fn of listeners['wc:' + ev] || []) fn(...a) },
    loadURLLog: [],
    loadURL (u) { this.loadURLLog.push(u); return Promise.resolve() }
  }
  const win = {
    webContents: wc,
    destroyed: false,
    on: (ev, fn) => { (listeners['win:' + ev] = listeners['win:' + ev] || []).push(fn) },
    emit: (ev, ...a) => { for (const fn of listeners['win:' + ev] || []) fn(...a) },
    isDestroyed () { return this.destroyed },
    destroy () { this.destroyed = true; this.emit('closed') }
  }
  return win
}

test('QC2: the backoff retry timer is cleared when the window closes (no post-destroy reload)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { attachLoadGuard } = require_(path.join(root, 'src/main/aux-load-guard.js'))
  const win = makeFakeWin()
  attachLoadGuard(win, { url: 'app://x#/qc', routeMark: 'qc', tag: 'QC', retries: 3, backoffMs: 100 })
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/qc', true) // arms a 100ms retry timer
  win.destroy() // 'closed' must clear the armed timer
  t.mock.timers.tick(500)
  assert.equal(win.webContents.loadURLLog.length, 0, 'armed retry never fired after close')
})

test('QC2: a successful load cancels a pending retry (no double loadURL)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { attachLoadGuard } = require_(path.join(root, 'src/main/aux-load-guard.js'))
  const win = makeFakeWin()
  attachLoadGuard(win, { url: 'app://x#/qc2', routeMark: 'qc2', tag: 'QC', retries: 3, backoffMs: 100 })
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/qc2', true)
  win.webContents.emit('did-finish-load') // load actually recovered before the timer fired
  t.mock.timers.tick(500)
  assert.equal(win.webContents.loadURLLog.length, 0, 'stale pending retry cancelled by did-finish-load')
})

test('QC2: source pin — retryTimer tracked, cleared on closed + did-finish-load, null-reset on fire', () => {
  const src = readMain('aux-load-guard.js')
  assert.match(src, /let retryTimer = null/)
  assert.match(src, /win\.on\('closed', clearRetryTimer\)/)
  assert.match(src, /did-finish-load.*clearRetryTimer\(\); retries = 0/s, 'did-finish-load clears the timer too')
  const handler = src.slice(src.indexOf("win.webContents.on('did-fail-load'"), src.indexOf('module.exports'))
  assert.match(handler, /clearRetryTimer\(\)\s*\n\s*retryTimer = setTimeout/, 'armed under the tracker')
  assert.match(handler, /retryTimer = null\s*\n\s*if \(win && !win\.isDestroyed\(\)\)/, 'timer self-nulls at fire time')
})

/* ---------- 3. windows.js crash-reload timer tracked + cleared on closed ---------- */

test('QC3: render-process-gone crash-reload timer is tracked and cleared in the closed handler (D21 parity)', () => {
  const src = readMain('windows.js')
  assert.match(src, /let crashReloadTimer = null/, 'timer is declared/tracked')
  const goneHandler = src.slice(src.indexOf("win.webContents.on('render-process-gone'"), src.indexOf("win.webContents.on('child-process-gone'"))
  assert.match(goneHandler, /crashReloadTimer = setTimeout\(/, '300ms reload armed under the tracker')
  assert.match(goneHandler, /crashReloadTimer = null\s*\n\s*try \{/, 'timer self-nulls at fire time')
  const closed = src.match(/win\.on\('closed', \(\) => \{(.*)\}\)\r?\n/)[1]
  assert.match(closed, /crashReloadTimer/, 'closed handler clears crashReloadTimer')
})

/* ---------- 4. command-bus runHooks log-isolation is warn-path only ---------- */

test('QC4: runHooks requires log-isolation inside the catch, not once per hook per commit', () => {
  const src = readMain('command-bus.js')
  const i = src.indexOf('function runHooks')
  const body = src.slice(i, src.indexOf('/**', i))
  const perHook = body.match(/for \(const h of hooks\) \{([\s\S]*?)\n {4}\}/)[1]
  // isolation require lives inside the catch block (warn path), never on the happy path
  const catchBlock = perHook.match(/catch \(e\) \{([\s\S]*?)\}/)[1]
  assert.match(catchBlock, /require\('\.\/log-isolation'\)/, 'isolation require is warn-path only')
  const happyPath = perHook.replace(/catch \(e\) \{[\s\S]*?\}/g, '')
  assert.doesNotMatch(happyPath, /require\('\.\/log-isolation'\)/, 'no per-hook isolation require on the happy path')
})

/* ---------- 5. renderer CLI tomato start: await giveUp before startFocus ---------- */

test('QC5: CLI `tomato start` over a running focus awaits the giveUp closeout before startFocus', () => {
  const src = readRenderer('renderer/js/main.js')
  const i = src.indexOf("if (cmd.action === 'start')")
  const branch = src.slice(i, src.indexOf("} else if (cmd.action === 'stop')"))
  const giveUpIdx = branch.indexOf("await store.dispatch('tomato/giveUp'")
  const startIdx = branch.indexOf("store.dispatch('tomato/startFocus')")
  assert.ok(giveUpIdx > 0, 'giveUp dispatch is awaited')
  assert.ok(startIdx > giveUpIdx, 'startFocus runs strictly after the awaited closeout')
  assert.doesNotMatch(branch, /\n\s*store\.dispatch\('tomato\/giveUp'/, 'no un-awaited giveUp left in the start branch')
})

/* ---------- 6. cross-window settings: equal stamps must not be dropped ---------- */

test('QC6: settings storage guard drops only STRICTLY older packets (equal stamps reach the content diff)', () => {
  const src = readRenderer('renderer/js/main.js')
  const i = src.indexOf("e.key === 'settingsState'")
  const guard = src.slice(i, src.indexOf('const patch = {}', i))
  assert.match(guard, /next\._lsAt && cur\._lsAt && next\._lsAt < cur\._lsAt\) return/,
    'guard uses strict < — equal stamps fall through to the per-key diff')
  assert.doesNotMatch(guard, /_lsAt <= cur\._lsAt/, 'the old <= same-ms packet drop is gone')
})

test('QC6: guard semantics — same-millisecond packet must reach the content diff (pure mirror)', () => {
  // Pure mirror of the guard + per-key diff from renderer/js/main.js (the renderer shell is not
  // requireable from node). If the source guard drifts, the source pin above fails; this test
  // pins the INTENDED semantics: equal stamps are resolved by content, not silently dropped.
  const guardDrops = (next, cur) => !!(next._lsAt && cur._lsAt && next._lsAt < cur._lsAt)
  const diff = (next, cur) => {
    if (guardDrops(next, cur)) return null
    const patch = {}
    for (const k of Object.keys(next)) {
      if (k.startsWith('_') || k === 'schemaV') continue
      if (JSON.stringify(next[k]) !== JSON.stringify(cur[k])) patch[k] = next[k]
    }
    return patch
  }
  const stamp = 1700000000000
  // strictly older packet: dropped (the original out-of-order rollback fix stays intact)
  assert.equal(diff({ _lsAt: stamp - 1, theme: 'dark' }, { _lsAt: stamp, theme: 'light' }), null)
  // EQUAL stamp with different content: the patch is applied (same-ms write loss fixed)
  assert.deepEqual(diff({ _lsAt: stamp, theme: 'dark' }, { _lsAt: stamp, theme: 'light' }), { theme: 'dark' })
  // EQUAL stamp with identical content: per-key diff no-ops
  assert.deepEqual(diff({ _lsAt: stamp, theme: 'light' }, { _lsAt: stamp, theme: 'light' }), {})
  // NEWER stamp: applied
  assert.deepEqual(diff({ _lsAt: stamp + 5, theme: 'dark' }, { _lsAt: stamp, theme: 'light' }), { theme: 'dark' })
})
