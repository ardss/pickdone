/* D14 C14 regression — liveServerSockets adoption rule. An inbound message used to
 * unconditionally re-set the per-peer socket ref (last-writer-wins): a STALE half-open
 * connection's late message overwrote the live socket, so notifyUnpaired then "succeeded" by
 * writing into a dead peer. adoptLiveSocket only adopts when there is no ref, the incumbent is
 * destroyed, or it IS the incumbent. Run:
 * node --test tests/unit/lan-sync/d14-c14-liveserver-socket-adoption.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

test('C14: adoptLiveSocket never lets a stale half-open socket overwrite the live ref', () => {
  const { adoptLiveSocket } = require_('../../../src/main/lan-sync/index.js')
  const map = new Map()
  const live = { destroyed: false }
  const stale = { destroyed: false }
  assert.equal(adoptLiveSocket(map, 'p1', live), true)
  // late message from the stale half-open connection: must NOT replace the live socket
  assert.equal(adoptLiveSocket(map, 'p1', stale), false, 'stale socket rejected while the incumbent is alive (red before the fix: last-writer-wins)')
  assert.equal(map.get('p1'), live)
  // a destroyed incumbent is reclaimed by the next inbound socket
  live.destroyed = true
  assert.equal(adoptLiveSocket(map, 'p1', stale), true)
  assert.equal(map.get('p1'), stale)
  // same-socket re-adoption (repeat messages) is a no-op set
  assert.equal(adoptLiveSocket(map, 'p1', stale), true)
})
