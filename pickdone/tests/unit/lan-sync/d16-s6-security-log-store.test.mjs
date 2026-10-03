/**
 * S6 regression (2026-10-03): the security ring is the second member of the settings-backed
 * whole-store class (the amended, previously unreported member). Pre-fix loadSecurityLog
 * silently defaulted to [] on an unreadable/undecodable row and BOTH writers (the <=1/s
 * throttled tick and the stopSync flush) then wrote the whole live array back — so one corrupt
 * read erased the durable 20-entry security ring on the next persist tick.
 *
 * Invariant (the paired-peers D15 C1 rule at whole-array granularity): no write is ever
 * derived from a failed read — with a corrupt 'sync.securityLog' row, the durable value stays
 * byte-identical through a persist tick and a stop flush, and the failure is visible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')

const K_SECURITY_LOG = 'sync.securityLog'
const CORRUPT = '[{"at":1,"ip":"x",,,,bad'

function dbWithCorruptRow () {
  const settings = new Map([[K_SECURITY_LOG, CORRUPT]])
  return {
    settings,
    call (op, p) {
      if (op === 'settingsRowPut') { settings.set(p.key, p.value); return null }
      if (op === 'settingsRowsAll') return [...settings.entries()].map(([key, value]) => ({ key, value, deleted: false }))
      return null
    },
  }
}

test('S6: loadSecurityLog seeds empty on a corrupt read and the throttled persist never writes it back', async () => {
  const db = dbWithCorruptRow()
  bootstrap.__test.setState({
    db,
    getWindowSenders: () => [],
    node: { getStatus: () => ({ security: [{ at: 5, ip: '1.2.3.4', reason: 'pair-throttled' }] }) },
    timers: [], engine: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  })
  try {
    const seeded = bootstrap.__test.loadSecurityLog()
    assert.deepEqual(seeded, [], 'a corrupt read seeds the ephemeral ring empty (never an erasing write)')
    bootstrap.__test.scheduleSecurityPersist()
    await new Promise(r => setTimeout(r, 1200)) // past the 1s write throttle
    assert.equal(db.settings.get(K_SECURITY_LOG), CORRUPT, 'the durable ring is byte-identical — the throttled whole-array write aborted while degraded')
  } finally {
    bootstrap.__test.setState(null)
  }
})

test('S6: the stopSync security flush also aborts while degraded; a successful read re-arms persistence', async () => {
  const db = dbWithCorruptRow()
  bootstrap.__test.setState({
    db,
    getWindowSenders: () => [],
    node: { getStatus: () => ({ security: [{ at: 6, ip: '5.6.7.8', reason: 'auth-rejected' }] }) },
    timers: [], engine: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  })
  try {
    bootstrap.__test.loadSecurityLog() // latch degraded via the corrupt read
    await bootstrap.__test.stopSync() // the stop-path flush must skip too
    assert.equal(db.settings.get(K_SECURITY_LOG), CORRUPT, 'the stop-path flush cannot shrink/erase the durable ring either')
  } finally {
    bootstrap.__test.setState(null)
  }

  // A SUCCESSFUL read re-arms persistence (transient failure, not a permanent off switch).
  const healthy = new Map([[K_SECURITY_LOG, JSON.stringify([{ at: 1, ip: '9.9.9.9', reason: 'pair-throttled' }])]])
  const db2 = {
    settings: healthy,
    call (op, p) {
      if (op === 'settingsRowPut') { healthy.set(p.key, p.value); return null }
      if (op === 'settingsRowsAll') return [...healthy.entries()].map(([key, value]) => ({ key, value, deleted: false }))
      return null
    },
  }
  bootstrap.__test.setState({
    db: db2,
    getWindowSenders: () => [],
    node: { getStatus: () => ({ security: [{ at: 1, ip: '9.9.9.9', reason: 'pair-throttled' }, { at: 7, ip: '8.8.8.8', reason: 'auth-rejected' }] }) },
    timers: [], engine: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  })
  try {
    const seeded = bootstrap.__test.loadSecurityLog()
    assert.equal(seeded.length, 1, 'a healthy read seeds the persisted ring')
    bootstrap.__test.scheduleSecurityPersist()
    await new Promise(r => setTimeout(r, 1200))
    const persisted = JSON.parse(healthy.get(K_SECURITY_LOG))
    assert.equal(persisted.length, 2, 'after a successful read the throttled persist writes through again')
    assert.equal(persisted[1].at, 7)
  } finally {
    bootstrap.__test.setState(null)
  }
})
