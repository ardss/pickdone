/** W31-F2 regression: the attachment pull quota is a SLIDING ROUND WINDOW, not a
 * session-lifetime counter. The old behavior stuffed a plain count into the node-level
 * `session.requests` map ("later sessions reset the budget" — they never did: `session`
 * lives for the whole process), so after MAX_REQUESTS_PER_SESSION batches maybeStart
 * returned false forever and client-round settled every round as a silent success while
 * attachment pulls stayed dead for the rest of the app's lifetime.
 *
 * Asserted (user-visible behavior, not internal shapes):
 *   - a first sync under 200 batches behaves exactly as before (every round pulls);
 *   - once the quota window is saturated, the NEXT round does NOT send an att-req and
 *     logs a warn (observable, not silent);
 *   - after enough rounds advance for the window to slide, pulls RESUME (budget reset);
 *   - legacy sessions that pre-stuffed a plain number keep the old capped semantics.
 * Run: node --test tests/unit/lan-sync/w31-att-quota-sliding-window.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const att = require('../../../src/main/lan-sync/att-transfer.js')

const noDeps = { exists: () => false, size: () => 0, read: () => Buffer.alloc(0), writeAtomic: () => true }

/** One simulated sync round: a fresh per-round puller over the shared session. Returns
 * true when an att-req went out (same contract client-round relies on). */
function runRound (session, round, keys = ['k.png']) {
  const sends = []
  const puller = att.createAttachmentPuller({
    send: m => sends.push(m), deps: noDeps, session, peerId: 'peer-1', round,
    getKeys: () => keys,
  })
  const started = puller.maybeStart(() => {}, () => {})
  if (started) puller.onMessage({ type: 'att-end', sent: 0, missing: keys.length })
  return { started, sends }
}

test('w31-F2: a first sync under the 200-batch quota pulls on every round (unchanged)', () => {
  const session = { failed: new Map(), requests: new Map() }
  for (let r = 1; r <= att.MAX_REQUESTS_PER_SESSION - 1; r++) {
    const { started, sends } = runRound(session, r)
    assert.equal(started, true, `round ${r} must still pull below the quota`)
    assert.equal(sends.length, 1)
  }
})

test('w31-F2: saturating the quota window caps the next round WITH a warn (not silent)', () => {
  const session = { failed: new Map(), requests: new Map() }
  const warns = []
  const log = require('electron-log')
  const origWarn = log.warn
  log.warn = (...args) => { warns.push(args.join(' ')) }
  try {
    for (let r = 1; r <= att.MAX_REQUESTS_PER_SESSION; r++) {
      assert.equal(runRound(session, r).started, true)
    }
    const capped = runRound(session, att.MAX_REQUESTS_PER_SESSION + 1)
    assert.equal(capped.started, false, 'the round after saturation must not send an att-req')
    assert.equal(capped.sends.length, 0, 'no att-req may leave while the quota window is saturated')
    assert.ok(warns.some(w => w.includes('quota window') && w.includes('peer-1')),
      `a warn naming the peer must be logged, got: ${JSON.stringify(warns)}`)
  } finally {
    log.warn = origWarn
  }
})

test('w31-F2: after the window slides, the budget resets and pulls resume (no permanent stall)', () => {
  const session = { failed: new Map(), requests: new Map() }
  for (let r = 1; r <= att.MAX_REQUESTS_PER_SESSION; r++) runRound(session, r)
  assert.equal(runRound(session, att.MAX_REQUESTS_PER_SESSION + 1).started, false, 'sanity: saturated now')
  // Advance past the window: every recorded round index is <= r - WINDOW, so all entries
  // slide out and the next round must pull again — the old code stayed dead forever here.
  const afterWindow = att.MAX_REQUESTS_PER_SESSION + att.ATT_QUOTA_WINDOW_ROUNDS
  const resumed = runRound(session, afterWindow)
  assert.equal(resumed.started, true, 'pulls must RESUME once the window slides past the saturated rounds')
  assert.equal(resumed.sends[0].type, 'att-req')
  // And the recovered budget is usable again for the following rounds.
  assert.equal(runRound(session, afterWindow + 1).started, true)
})

test('w31-F2: legacy number-shaped session entries keep the old capped semantics', () => {
  const session = { failed: new Map(), requests: new Map() }
  session.requests.set('peer-1', att.MAX_REQUESTS_PER_SESSION)
  // Legacy shape = no round clock: the plain number keeps its non-expiring meaning.
  const puller = att.createAttachmentPuller({
    send: () => {}, deps: noDeps, session, peerId: 'peer-1',
    getKeys: () => ['k.png'],
  })
  assert.equal(puller.maybeStart(() => {}, () => {}), false)
})
