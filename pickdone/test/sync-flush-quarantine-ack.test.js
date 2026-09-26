/* stalled-push-watermark-null LAYER 1 regression (2026-09-26):
 * Before the fix, flushOne set ok=false whenever a bulk op threw — even when the failing op's
 * rows were successfully quarantined under sync.flushQuarantine.<op>. ingestSegment then stamped
 * flushFailed, the ack stayed below the segment, and the sender's push watermark never advanced:
 * the SAME segment (with the SAME poison row) was re-pushed every round forever — a permanent
 * stall. After the fix (Layer 1), a successful quarantine commits the remaining ops and returns
 * { ok: true, quarantined } so the ack advances with appliedToSeq in the sender's seq space;
 * ok=false is reserved for quarantine PARKING failure (log-only drop → fail closed, watermark
 * safe, old behavior). lan-sync-bootstrap finalizeIngest correspondingly surfaces
 * 'flush-quarantined' OUTSIDE the ok===false branch and throws on snapshot only for parking
 * failure.
 * Real DB in fresh temp dirs (TODO_DB_DIR / TODO_USER_DATA_DIR) — never the real %APPDATA%.
 * Run: node --test test/sync-flush-quarantine-ack.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-ack-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-ack-ud-'))

const manifest = require('../src/main/command-manifest')
const apply = require('../src/main/sync-apply.js')
const bootstrap = require('../src/main/lan-sync-bootstrap.js')
const { META_FLUSH_QUARANTINE_PREFIX } = apply

const TODO_OP = manifest.COMMANDS['todo.putMany'].op
const SETTING_OP = manifest.COMMANDS['setting.putMany'].op

function emptyBuf () {
  return { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
}

/** Stub db: throws on the todo bulk op (the "poison row"), records everything else. */
function poisonDb ({ failParking = false } = {}) {
  const calls = []
  return {
    calls,
    call (op, payload) {
      calls.push({ op, payload })
      if (op === TODO_OP) throw new Error('SQLITE_MISUSE: poison row rejected')
      if (failParking && op === 'setMeta') throw new Error('meta store unavailable')
      if (op === 'getMeta') return null
      return { changes: 1 }
    }
  }
}

function flushState (db, buf) {
  return { db, pendingWrites: buf, pendingAnnounces: null }
}

function bootState (db, buf, senders = []) {
  return { db, pendingWrites: buf, pendingAnnounces: null, applied: null, getWindowSenders: () => senders }
}

test('REGRESSION: quarantined poison op no longer fails the flush — ack can advance (Layer 1)', () => {
  const db = poisonDb()
  const buf = emptyBuf()
  buf.todos = [{ taskId: 'poison-1', taskContent: 'x' }]
  buf.settings = [['syncTestKey', 1]]
  const r = apply.flushPendingWrites(flushState(db, buf))
  // Before the fix this was ok:false → flushFailed → watermark pinned on the poison row forever.
  assert.equal(r.ok, true, 'successful quarantine must NOT fail the flush (was the stall)')
  assert.equal(r.quarantined.length, 1)
  assert.equal(r.quarantined[0].op, TODO_OP)
  assert.equal(r.quarantined[0].count, 1)
  // remaining ops committed past the poison op
  assert.ok(db.calls.some(c => c.op === SETTING_OP), 'ops after the poison op still commit')
  // rows actually parked in the machine-local quarantine meta key
  const setMeta = db.calls.filter(c => c.op === 'setMeta')
  assert.equal(setMeta.length, 1)
  const key = META_FLUSH_QUARANTINE_PREFIX + TODO_OP
  assert.equal(setMeta[0].payload[0], key)
  const parked = JSON.parse(setMeta[0].payload[1])
  assert.equal(parked.length, 1)
  assert.equal(parked[0].rows[0].taskId, 'poison-1')
  assert.match(parked[0].error, /poison row/)
})

test('quarantine PARKING failure still fails the flush (log-only drop → watermark safe)', () => {
  const db = poisonDb({ failParking: true })
  const buf = emptyBuf()
  buf.todos = [{ taskId: 'poison-2', taskContent: 'x' }]
  const r = apply.flushPendingWrites(flushState(db, buf))
  assert.equal(r.ok, false, 'parking failure must degrade to fail-closed (segment not acked)')
  assert.equal(r.quarantined.length, 0, 'nothing was parked')
})

test('bootstrap finalizeIngest: quarantined-but-ok flush acks (no flushFailed) and still surfaces flush-quarantined', () => {
  const db = poisonDb()
  const sent = []
  const sender = { send: (ch, msg) => sent.push({ ch, msg }), isDestroyed: () => false }
  bootstrap.__test.setState(bootState(db,
    (() => { const b = emptyBuf(); b.todos = [{ taskId: 'poison-3' }]; return b })(), [sender]))
  const r = bootstrap.__test.finalizeIngest({ applied: 1 })
  assert.equal(r.flushFailed, undefined, 'quarantined round must NOT stamp flushFailed (ack advances)')
  assert.equal(r.quarantined.length, 1)
  const ev = sent.find(s => s.ch === 'syncEvent' && s.msg.type === 'flush-quarantined')
  assert.ok(ev, 'quarantine stays user-visible via Device Center syncEvent')
  assert.equal(ev.msg.count, 1)
})

test('bootstrap finalizeIngest: parking failure stamps flushFailed; snapshot path throws (watermark safe)', () => {
  const db = poisonDb({ failParking: true })
  bootstrap.__test.setState(bootState(db,
    (() => { const b = emptyBuf(); b.todos = [{ taskId: 'poison-4' }]; return b })()))
  const r = bootstrap.__test.finalizeIngest({ applied: 1 })
  assert.equal(r.flushFailed, true, 'log-only drop keeps the ack below the segment')
  // fresh poison buffer: the first finalizeIngest drained the previous one
  bootstrap.__test.setState(bootState(db,
    (() => { const b = emptyBuf(); b.todos = [{ taskId: 'poison-4b' }]; return b })()))
  assert.throws(() => bootstrap.__test.finalizeIngest({}, { snapshot: true }),
    /flush failed \(rows dropped, snapshot will retry\)/)
})

test('bootstrap finalizeIngest: quarantined-but-ok snapshot path does NOT throw (rows are recoverable)', () => {
  const db = poisonDb()
  bootstrap.__test.setState(bootState(db,
    (() => { const b = emptyBuf(); b.todos = [{ taskId: 'poison-5' }]; return b })()))
  const r = bootstrap.__test.finalizeIngest({}, { snapshot: true })
  assert.equal(r.flushFailed, undefined)
  assert.equal(r.quarantined.length, 1)
})
