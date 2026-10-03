/** D10 domain-D fixes (2026-09-27) — pure helpers + quit-chain guards:
 *  - computeMetaGc new families: projectStatus:/projectCategoryFlag: die for purged categories,
 *    catProjectMetaBak.pending.* crash markers always die (non-pending catProjectMetaBak.<id> kept);
 *  - isLiveTextFresh: tomatoLiveText is a lease, not a latch (quitFromTray false-confirm root fix);
 *  - crashRelaunchDecision: persisted relaunch counter caps the renderer crash→relaunch storm;
 *  - quit-guards: hang fallback arms synchronously (before any await), re-entrancy guard,
 *    shouldRunQuitFlush short-circuits the second instance.
 * Run: node --test tests/unit/main/d10-domain-d-pure-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shared = require('../../../src/main/handlers/shared.js')
const { createHangFallback, createReentrancyGuard, shouldRunQuitFlush } = require('../../../src/main/quit-guards.js')

/* ---- computeMetaGc missing families ---- */
test('d10: computeMetaGc GCs projectStatus/projectCategoryFlag of purged categories and pending crash markers', () => {
  const cats = [{ id: 'cat-live' }]
  const todos = [{ taskId: 't1', repeatId: 'r1' }]
  const keys = [
    'projectStatus:cat-live',          // live category: kept
    'projectStatus:cat-dead',          // purged: dies
    'projectCategoryFlag:cat-live',    // live: kept
    'projectCategoryFlag:cat-dead',    // purged: dies
    'projectDeadline:cat-dead',        // pre-existing family: still dies
    'catProjectMetaBak.pending.abc',   // crash marker: always dies
    'catProjectMetaBak.pending.xyz',
    'catProjectMetaBak.cat-dead',      // recovery anchor of a soft-deleted category: KEPT
    'catProjectMetaBak.cat-live',      // live category anchor: kept
    'repeatRule:r1',                   // live: kept
    'tomatoEstimateState:t1',          // live: kept
  ]
  const dead = shared.computeMetaGc(keys, cats, todos)
  assert.deepEqual(dead.sort(), [
    'catProjectMetaBak.pending.abc',
    'catProjectMetaBak.pending.xyz',
    'projectCategoryFlag:cat-dead',
    'projectDeadline:cat-dead',
    'projectStatus:cat-dead',
  ])
})

/* ---- tomatoLiveText lease ---- */
test('d10: isLiveTextFresh — stale text (renderer died mid-pomodoro) is not live, fresh text is', () => {
  const now = 1_000_000
  assert.equal(shared.isLiveTextFresh('12:34', now - 1000, now), true, '1s-old push: live')
  assert.equal(shared.isLiveTextFresh('12:34', now - 60_000, now), false, '60s-old push: stale — no confirm dialog')
  assert.equal(shared.isLiveTextFresh('', now, now), false, 'empty text never live')
  assert.equal(shared.isLiveTextFresh('12:34', 0, now), false, 'never-pushed text never live')
  assert.equal(shared.isLiveTextFresh('12:34', now - 10_000, now), false, 'exactly at TTL boundary: stale')
})

/* ---- crash relaunch cap ---- */
test('d10: crashRelaunchDecision — relaunch under the cap, give-up at/over it', () => {
  assert.equal(shared.crashRelaunchDecision(0), 'relaunch')
  assert.equal(shared.crashRelaunchDecision(2), 'relaunch')
  assert.equal(shared.crashRelaunchDecision(3), 'give-up', 'at cap: stop relaunching, show the fatal dialog')
  assert.equal(shared.crashRelaunchDecision(7), 'give-up')
})

/* ---- quit-guards: hang fallback ---- */
test('d10: hang fallback arms the exit timer SYNCHRONOUSLY (before any awaited flush step)', () => {
  let fired = 0
  const timers = []
  const st = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }
  const ct = t => { t.cleared = true }
  const fb = createHangFallback({ timeoutMs: 3000, onExit: () => fired++, setTimeout: st, clearTimeout: ct })
  assert.equal(fb.armed, false)
  fb.arm() // flushNow entry — no await before this point
  assert.equal(fb.armed, true, 'timer registered synchronously at flushNow start')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 3000)
  fb.arm()
  assert.equal(timers.length, 1, 'arm is idempotent — never stacks exit timers')
  fb.disarm()
  assert.equal(fb.armed, false)
  assert.equal(timers[0].cleared, true, 'disarm clears the pending hard exit')
  // never-settling flush: the armed timer is the only thing that exits the process
  fb.arm()
  timers[0].fn()
  assert.equal(fired, 1, 'the fallback fires the exit callback')
})

/* ---- quit-guards: re-entrancy ---- */
test('d10: reentrancy guard — second quitFromTray entry while the dialog is open is refused', () => {
  const g = createReentrancyGuard()
  assert.equal(g.enter(), true, 'first invocation enters')
  assert.equal(g.enter(), false, 'second invocation (dialog still open) refused')
  g.exit() // cancel branch / finally
  assert.equal(g.enter(), true, 'after exit a new invocation may proceed')
  g.exit()
})

/* ---- quit-guards: second-instance flush skip ---- */
test('d10: shouldRunQuitFlush — second instance short-circuits the quit-flush chain', () => {
  assert.equal(shouldRunQuitFlush({ ranFullInit: false, flushDone: false, quitting: false }), false,
    'singleton-loser duplicate: nothing to flush, pass the quit straight through')
  assert.equal(shouldRunQuitFlush({ ranFullInit: true, flushDone: false, quitting: false }), true, 'winner: run the flush')
  assert.equal(shouldRunQuitFlush({ ranFullInit: true, flushDone: true, quitting: false }), false, 'flush done: passthrough')
  assert.equal(shouldRunQuitFlush({ ranFullInit: true, flushDone: false, quitting: true }), false, 'flush window already open')
})

/* ---- TQ-7 (2026-10-03): the singleton-winner-only invariant is enforced in BOTH quit phases ----
 * index.js cannot be require()d under plain node (Electron bootstrap), so the before-quit entry
 * itself is out of reach; the regression anchors the SOURCE: before-quit must gate on the shared
 * predicate, not on the bare flushDone flag that let a singleton-lock loser run the acting phase. */
test('tq7: before-quit shares the shouldRunQuitFlush predicate (no bare flushDone guard left)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
  const src = readFileSync(join(root, 'src/main/index.js'), 'utf8')
  const beforeQuit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('window-all-closed'"))
  assert.ok(beforeQuit.length > 0, 'before-quit handler located')
  assert.ok(beforeQuit.includes('shouldRunQuitFlush({ ranFullInit, flushDone, quitting })'),
    'before-quit gates on the shared predicate — the acting quit phase enforces the same singleton-winner contract as will-quit')
  assert.ok(!beforeQuit.includes('if (flushDone) return'),
    'no bare flushDone guard: the split-guard root (acting phase unguarded) is removed')
})
