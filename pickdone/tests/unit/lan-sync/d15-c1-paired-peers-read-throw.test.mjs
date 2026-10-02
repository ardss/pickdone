/* D15 C1 regression — a paired-peers READ failure must not turn into a destructive WRITE.
 * The old loadPairedPeers() caught every read/parse error and returned {}, so
 * persistPairedPeer() merged the new peer into that empty map and settingPut erased EVERY
 * previously paired peer (per-pair secrets included) whenever db.call threw (busy/closed).
 * Now a read failure throws; persist/remove abort and the old durable map survives untouched.
 * Run: node --test tests/unit/lan-sync/d15-c1-paired-peers-read-throw.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createPairedPeers = require('../../../src/main/lan-sync/paired-peers')

const GOOD_MAP = JSON.stringify({
  peerA: { deviceId: 'peerA', name: 'A', host: '192.168.1.10', port: 58470, pairedAt: 1, secret: 's-A' },
  peerB: { deviceId: 'peerB', name: 'B', host: '192.168.1.11', port: 58470, pairedAt: 2, secret: 's-B' },
})

/** settingGet that throws (simulating a busy/closed db via db.call) but records settingPut calls. */
function flakyPeers ({ failReads }) {
  const puts = []
  const pp = createPairedPeers({
    settingGet: () => { if (failReads.value) { throw new Error('SQLITE_BUSY: database is locked') } return GOOD_MAP },
    settingPut: (k, v) => { puts.push({ k, v }) },
    log: { warn: () => {} },
    isDialableHost: () => true,
    DEFAULT_PORT: 58470,
    K_PAIRED_PEERS: 'sync.pairedPeers',
  })
  return { pp, puts }
}

test('C1: persistPairedPeer during a read failure must NOT erase the other paired peers', () => {
  const failReads = { value: true }
  const { pp, puts } = flakyPeers({ failReads })
  const r = pp.persistPairedPeer({ deviceId: 'peerC', name: 'C', host: '192.168.1.12', port: 58470, secret: 's-C' })
  assert.equal(r, false, 'persist aborts on a failed read (red before the fix: returned true and wrote an empty-derived map)')
  assert.equal(puts.length, 0, 'NO write may be derived from a failed read (red before: settingPut stored {"peerC":...}, wiping peerA/peerB + secrets)')
})

test('C1: removePairedPeer during a read failure must not write either', () => {
  const failReads = { value: true }
  const { pp, puts } = flakyPeers({ failReads })
  pp.removePairedPeer('peerA')
  assert.equal(puts.length, 0, 'a removal must also never be derived from a failed read')
})

test('C1: persist works normally once reads recover — no lost peers, secret preserved', () => {
  const failReads = { value: false }
  const { pp, puts } = flakyPeers({ failReads })
  assert.equal(pp.persistPairedPeer({ deviceId: 'peerC', name: 'C', host: '192.168.1.12', port: 58470, secret: 's-C' }), true)
  assert.equal(puts.length, 1)
  const written = JSON.parse(puts[0].v)
  assert.equal(written.peerA.secret, 's-A', 'peerA survives')
  assert.equal(written.peerB.secret, 's-B', 'peerB survives')
  assert.equal(written.peerC.secret, 's-C', 'new peer added')
})

test('C1: a malformed stored value still yields {} on load (readable but junk is not a read failure)', () => {
  const pp = createPairedPeers({
    settingGet: () => 'not-json',
    settingPut: () => {},
    log: { warn: () => {} },
    isDialableHost: () => true,
    DEFAULT_PORT: 58470,
    K_PAIRED_PEERS: 'sync.pairedPeers',
  })
  assert.throws(() => pp.loadPairedPeers(), /paired-peers read failed/)
})
