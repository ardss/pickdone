/* C11 (2026-09-26): during the quit flush window (up to 2s between will-quit entry and
 * flushNow's stopDbWatch) the external-DB-write poll was still live, and its forward closures
 * called dbm.call, could send a pending CLI command to an already-flushed renderer and delete
 * the consumed slot — the resulting write could land after dbm.close() and be silently dropped
 * (permanent command loss). The poll tick is now gated at its single entry point: once the
 * quit chain arms ext-watch-gate, every onChange tick is a no-op.
 * This file is plain Node (no electron launch, no real %APPDATA%): the gate decision is
 * exercised functionally; the index.js wiring is pinned by source (the F-A5 convention — the
 * entry file cannot be require()d under plain node without executing the app bootstrap).
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/ext-watch-quit-gate.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const gate = require_('../src/main/ext-watch-gate.js')

test('C11 gate: ticks poll freely until will-quit arms the gate, then every tick is a no-op', () => {
  gate.__reset()
  assert.equal(gate.canPoll(), true, 'normal operation: the poll runs')
  assert.equal(gate.isArmed(), false)
  gate.arm() // what index.js will-quit does, before the flush window opens
  assert.equal(gate.canPoll(), false, 'THE FIX: inside the quit flush window no tick may proceed')
  assert.equal(gate.canPoll(), false, 'still gated on later ticks (incl. one already-scheduled tick after unwatch)')
  gate.__reset()
  assert.equal(gate.canPoll(), true, 'reset restores polling (test hygiene)')
})

test('C11 wiring: index.js consults the gate at the single onChange entry and arms it at will-quit entry', () => {
  const src = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
  const onChangeIdx = src.indexOf('const onChange = () => {')
  assert.ok(onChangeIdx > 0, 'onChange found')
  const onChangeBody = src.slice(onChangeIdx, src.indexOf('fs.watchFile(dbFile', onChangeIdx))
  assert.ok(onChangeBody.includes('extWatchGate.canPoll()'),
    'onChange must early-return on the quit gate BEFORE any readWatchMtime/dbm.call/send')
  assert.ok(onChangeBody.indexOf('extWatchGate.canPoll()') < onChangeBody.indexOf('readWatchMtime()'),
    'the gate is the FIRST thing the tick checks (no reads happen when gated)')
  const quitIdx = src.indexOf('quitting = true')
  assert.ok(quitIdx > 0)
  const quitBlock = src.slice(quitIdx, quitIdx + 200)
  assert.ok(quitBlock.includes('extWatchGate.arm()'),
    'the gate is armed at will-quit entry, before the 500ms-2s flush window opens')
})

test('Round-3 (2026-09-26): stopDbWatch clears the pending debounce kick, and the kick flush body is gate-checked', () => {
  const src = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
  // (a) stopDbWatch must clearTimeout(debounce) BEFORE releasing the poll timers — a kick
  // scheduled within the 150ms debounce window must not fire against the closed DB handle.
  const stopIdx = src.indexOf('stopDbWatch = () => {')
  assert.ok(stopIdx > 0, 'stopDbWatch found')
  const stopBody = src.slice(stopIdx, src.indexOf('}', src.indexOf('resyncDbWatch = null', stopIdx)))
  assert.ok(stopBody.includes('clearTimeout(debounce)'),
    'THE FIX: stopDbWatch clears the pending debounce kick before closing down the poll')
  assert.ok(stopBody.indexOf('clearTimeout(debounce)') < stopBody.indexOf('unwatchFile'),
    'the debounce clear happens with the teardown (first thing stopDbWatch does)')
  // (b) the kick callback's flush body must re-check the gate: a timer armed just before the
  // quit chain arms the gate fires INSIDE the flush window, where its forwardTomatoCmd/dbm.call
  // would consume a CLI slot whose write lands after dbm.close().
  const kickIdx = src.indexOf('debounce = setTimeout(() => {')
  assert.ok(kickIdx > 0, 'kick debounce timer found')
  const kickBody = src.slice(kickIdx, src.indexOf("}, 150)", kickIdx))
  assert.ok(kickBody.includes('extWatchGate.canPoll()'),
    'THE FIX: the kick flush body is gated by extWatchGate.canPoll()')
  assert.ok(kickBody.indexOf('extWatchGate.canPoll()') < kickBody.indexOf("scheduler.reloadAll"),
    'the gate check runs BEFORE any dbm.call (scheduler.reloadAll / forwardTomatoCmd)')
})
