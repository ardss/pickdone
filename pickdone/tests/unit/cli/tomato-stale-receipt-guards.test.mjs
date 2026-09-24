/** CLI tomato stale-command guards (originating from the round-4-review 2026-09-11 pre-release audit;
 *  renamed 2026-09-24 from r4-review-guards.test.mjs to a domain name and grouped under cli/): a P1 fix
 *  that previously had NO test — reverting it used to leave the suite green.
 *  Coverage: CLI tomato expired receipt (tomatoShared.js isStaleTomatoCmd / expiredTomatoReceipt,
 *  consumed by renderer main.js onCliTomatoCmd) — TTL boundary + receipt shape the CLI's
 *  waitForTomatoAck needs. (The two main-process r4 guards live in
 *  tests/unit/main/watch-resync-quitack-guards.test.mjs.)
 * Run: node --test tests/unit/cli/tomato-stale-receipt-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readAnchor } from '../../lib/source-anchors.mjs'

const require_ = createRequire(import.meta.url)

test('cli tomato: TTL boundary and missing-at rejection', () => {
  const { TOMATO_CMD_TTL_MS, isStaleTomatoCmd } = require_('../../../renderer/js/utils/tomatoShared.js')
  assert.equal(TOMATO_CMD_TTL_MS, 60000)
  assert.equal(isStaleTomatoCmd({ at: 40_000 }, 100_000), false, 'exactly at the TTL edge is still fresh (60s)')
  assert.equal(isStaleTomatoCmd({ at: 39_999 }, 100_000), true, 'one ms past the TTL is stale')
  assert.equal(isStaleTomatoCmd({ at: 99_999 }, 100_000), false, 'fresh command')
  assert.equal(isStaleTomatoCmd({}, 100_000), true, 'missing at = stale (crash-replay protection)')
  assert.equal(isStaleTomatoCmd(null, 100_000), true, 'missing cmd = stale')
})

test('cli tomato: expired receipt keeps the command seq so waitForTomatoAck can unblock', () => {
  const { expiredTomatoReceipt } = require_('../../../renderer/js/utils/tomatoShared.js')
  const now = 1_234_567
  const r = expiredTomatoReceipt({ seq: 7, action: 'start', at: 1 }, now)
  assert.deepEqual(r, { seq: 7, status: 'expired', error: 'stale command (>60s)', at: now })
  assert.equal(expiredTomatoReceipt(null, now).seq, 0, 'degenerate cmd still yields a well-formed receipt')
})

test('cli tomato wiring: renderer main.js writes the receipt (not a silent return) on stale commands', () => {
  const src = readAnchor('rendererMain')
  const idx = src.indexOf('isStaleTomatoCmd(cmd, Date.now())')
  assert.ok(idx > 0, 'stale check routed through the tested pure helper')
  const block = src.slice(idx, idx + 500)
  assert.match(block, /cliTomatoState[\s\S]{0,200}expiredTomatoReceipt/, 'stale rejection writes the expired receipt to cliTomatoState')
})
