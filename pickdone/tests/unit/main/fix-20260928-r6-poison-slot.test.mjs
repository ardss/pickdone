/**
 * r6 main fixes (2026-09-28), poison-slot parity across the three CLI channels:
 *  1. fix-util.tryForwardTomatoCmd — an unparseable cliTomatoCmd payload no longer returns
 *     untouched forever (slot never cleared → JSON.parse retried every 500ms poll): the parse
 *     failure invokes clearCmd(null, raw) so the CALLER compare-and-deletes by the exact raw
 *     value, and reports poisoned:true for the caller's warn. Same contract as cli-sync-channel
 *     since D6 P2 — previously the self-heal existed only on the sync side.
 *  2. external-db-watch settings hot-sync — a corrupted db.settingsState blob degrades ONCE per
 *     distinct payload (single warn, tick skipped) instead of throwing into the outer catch every
 *     poll while lastSettingsSavedAt never advances; parsing resumes when the CLI rewrites the blob.
 *  3. cli-slot-policy.isStaleSlotCmd — the TTL-abandon predicate is now exported ONCE and used by
 *     all three consumers (seedSlotWatermark, tryForwardTomatoCmd, cli-sync-channel.forward);
 *     the test asserts the three paths give the SAME verdict for the same slot state.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { tryForwardTomatoCmd } = require('../../../src/main/fix-util.js')
const { CLI_SLOT_ABANDON_TTL_MS, seedSlotWatermark, isStaleSlotCmd } = require('../../../src/main/cli-slot-policy.js')
const { createExternalDbWatch } = require('../../../src/main/external-db-watch.js')
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')

const NOW = Date.now()

/* ---------- 1. tomato poisoned slot: consume+clear, no infinite retry ---------- */

function mockWin () {
  const sent = []
  return { sent, win: { webContents: { send: (ch, cmd) => sent.push({ ch, cmd }) } } }
}

test('tomato poison: unparseable payload triggers clearCmd(null, raw) + poisoned:true, no send', () => {
  const { sent, win } = mockWin()
  const POISON = '{"seq":9,"action":"start" ' // truncated JSON — parse always fails
  const clears = []
  const st = tryForwardTomatoCmd({
    raw: POISON,
    lastTomatoCmdRaw: null, lastTomatoSeq: 8,
    getMainWindow: () => win, isLocked: () => false,
    clearCmd: (cmd, raw) => clears.push([cmd, raw]),
    now: NOW,
  })
  assert.equal(st.sent, false, 'nothing to send')
  assert.equal(st.poisoned, true, 'caller is told the slot was poisoned (warn surface)')
  assert.equal(st.lastTomatoSeq, 8, 'seq watermark untouched — nothing consumable was in the payload')
  assert.equal(sent.length, 0)
  assert.deepEqual(clears, [[null, POISON]], 'clearCmd(null, raw): the caller compare-and-deletes by exact raw value')
})

test('tomato poison: slot cleanup via raw compare — a newer valid command is never eaten', () => {
  // fake meta slot: poisoned raw still present → delete; a NEWER command already landed → keep
  const POISON = 'not-json-at-all'
  const NEWER = JSON.stringify({ seq: 10, at: NOW - 1000, action: 'stop' })
  const run = (slotNow) => {
    let deleted = false
    tryForwardTomatoCmd({
      raw: POISON, lastTomatoCmdRaw: null, lastTomatoSeq: 8,
      getMainWindow: () => null, // irrelevant for the poison path
      clearCmd: (cmd, raw) => { if (slotNow === raw) deleted = true },
      now: NOW,
    })
    return deleted
  }
  assert.equal(run(POISON), true, 'slot still holds the poisoned payload → cleared')
  assert.equal(run(NEWER), false, 'slot was overwritten by a newer command → cleanup must not eat it')
})

test('tomato poison: next poll with the slot cleared is a no-op (no retry loop)', () => {
  const POISON = '{"broken'
  let raw = POISON
  const st1 = tryForwardTomatoCmd({
    raw, lastTomatoCmdRaw: null, lastTomatoSeq: 0,
    clearCmd: (cmd, r) => { if (r === raw) raw = null }, // caller-side compare-and-delete
  })
  assert.equal(st1.poisoned, true)
  // next poll: raw is null → early untouched return, JSON.parse never re-attempted
  const st2 = tryForwardTomatoCmd({ raw, lastTomatoCmdRaw: null, lastTomatoSeq: 0 })
  assert.equal(st2.poisoned, false)
  assert.equal(st2.sent, false)
  assert.equal(raw, null, 'slot was cleared — the next poll cannot re-attempt the same parse')
})

/* ---------- 2. settings hot-sync: one-shot degrade on a corrupted blob ---------- */

function fakeWatchDeps ({ meta, warnCount }) {
  const fs = require('fs')
  const realWatchFile = fs.watchFile
  let onChange = null
  fs.watchFile = (f, opts, cb) => { onChange = cb }
  fs.unwatchFile = () => {}
  const origStatSync = fs.statSync
  fs.statSync = () => ({ mtimeMs: 1000 }) // constant → stableRead agrees, mtime never "changes"
  const deps = {
    app: { getPath: () => '/tmp/fake-ud' },
    log: { info: () => {}, warn: (...a) => { warnCount.count++ } },
    dbm: { call: (op, k) => meta.has(k) ? meta.get(k) : null },
    fixUtil: require('../../../src/main/fix-util.js'),
    extWatchGate: { canPoll: () => true },
    nextWatchBaseline: (prev) => prev,
    scheduler: { reloadAll: () => {} },
    getMainWindow: () => null,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    broadcastTomatoRecordsChanged: () => {},
    BrowserWindow: { getAllWindows: () => [] },
  }
  const w = createExternalDbWatch(deps)
  w.watchDbForExternalWrites()
  fs.watchFile = realWatchFile
  // statSync stays patched until restore() — readWatchMtime runs inside each tick against the
  // fake path; restoring early would make every tick a null read (onChange early-returns).
  return { tick: () => onChange(), restore: () => { fs.statSync = origStatSync } }
}

test('settings poison: corrupt blob warns ONCE, degrades, recovers after the CLI rewrites it', () => {
  const warnCount = { count: 0 }
  const meta = new Map([['db.settingsState', '{corrupt-blob']])
  const { tick, restore } = fakeWatchDeps({ meta, warnCount })
  tick() // arms baseline (forwardTomatoCmd runs → settings section parses → poison)
  assert.equal(warnCount.count, 1, 'exactly one degrade warn for the poisoned blob')
  tick()
  tick()
  assert.equal(warnCount.count, 1, 'repeated polls on the SAME payload do not re-warn (one-shot degrade)')
  // CLI rewrites the blob → parsing resumes, no new warn
  meta.set('db.settingsState', JSON.stringify({ _savedAt: NOW }))
  tick()
  assert.equal(warnCount.count, 1, 'recovered: valid blob parses, no warn')
  // a DIFFERENT corrupted payload warns again (per-distinct-payload policy)
  meta.set('db.settingsState', '{corrupt-two')
  tick()
  assert.equal(warnCount.count, 2, 'a new distinct poisoned payload surfaces once again')
  restore()
})

test('settings poison: healthy path still advances the watermark (no false degrade)', () => {
  const warnCount = { count: 0 }
  const meta = new Map([['db.settingsState', JSON.stringify({ _savedAt: 500 })]])
  const { tick, restore } = fakeWatchDeps({ meta, warnCount })
  tick()
  tick()
  assert.equal(warnCount.count, 0)
  restore()
})

/* ---------- 3. isStaleSlotCmd: one predicate, three consumers, identical verdicts ---------- */

test('isStaleSlotCmd: exported and matches the previous hand-copied expression', () => {
  assert.equal(isStaleSlotCmd({ at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1 }, NOW), true, 'stale stamped → abandon')
  assert.equal(isStaleSlotCmd({ at: NOW - 1000 }, NOW), false, 'fresh stamped → execute')
  assert.equal(isStaleSlotCmd({}, NOW), false, 'no stamp → execute-once (never guessed stale)')
  assert.equal(isStaleSlotCmd(null, NOW), false, 'null-safe')
})

test('the three consumers agree on the same slot state (no drift)', () => {
  const staleRaw = JSON.stringify({ seq: 5, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 5, action: 'start' })
  const freshRaw = JSON.stringify({ seq: 5, at: NOW - 5, action: 'status' })
  for (const [label, raw] of [['stale', staleRaw], ['fresh', freshRaw]]) {
    const stale = isStaleSlotCmd(JSON.parse(raw), NOW)
    // seed path (tomato/sync share seedSlotWatermark)
    const abandoned = []
    const wm = seedSlotWatermark({ counter: 5, slotRaw: raw, now: NOW, onAbandon: q => abandoned.push(q.seq) })
    // runtime tomato path
    const { win } = mockWin()
    const st = tryForwardTomatoCmd({ raw, lastTomatoCmdRaw: null, lastTomatoSeq: 4, getMainWindow: () => win, isLocked: () => false, now: NOW })
    // runtime sync path
    const receipts = []
    const ch = createSyncCmdHandler({
      dispatch: () => { receipts.push('exec'); return {} }, setMeta: () => {},
      log: { warn: () => {} },
    })
    ch.forward(raw)
    if (stale) {
      assert.equal(wm, 5, label + ': seed keeps counter')
      assert.deepEqual(abandoned, [5], label + ': seed abandons')
      assert.equal(st.abandoned, true, label + ': tomato runtime abandons')
      assert.equal(st.sent, false, label + ': tomato runtime does not send')
      assert.equal(receipts.length, 0, label + ': sync runtime does not execute')
    } else {
      assert.equal(wm, 4, label + ': fresh seed → counter-1 execute-once')
      assert.deepEqual(abandoned, [], label + ': fresh seed does not abandon')
      assert.equal(st.sent, true, label + ': fresh tomato sends')
      return new Promise(r => setTimeout(r, 20)).then(() => {
        assert.deepEqual(receipts, ['exec'], label + ': fresh sync executes once')
      })
    }
  }
})
