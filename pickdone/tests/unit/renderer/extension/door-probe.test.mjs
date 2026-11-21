// J3 sentinel (qa-r7 P1): a 7789 port conflict must produce a USER-VISIBLE state with
// retry guidance — never a silent failure. The classifier is pure ESM so both the popup
// and Node tests share the exact same user-facing wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDoorProbe, DOOR_HEADER, PORT_HEADER } from '../../../../extension/shared/door-probe.js'

test('unreachable: connection refused/absent desktop is a visible error with start-PickDone guidance', () => {
  const r = classifyDoorProbe({ endpoint: 'http://127.0.0.1:7789/capture', error: new TypeError('fetch failed') })
  assert.equal(r.state, 'unreachable')
  assert.match(r.message, /not reachable/i)
  assert.match(r.message, /PickDone/i)
  assert.equal(r.bad, true)
})

test('foreign: an HTTP answer without the PickDone door header means the port is held by another program', () => {
  const r = classifyDoorProbe({ endpoint: 'http://127.0.0.1:7789/capture', status: 404, headers: {} })
  assert.equal(r.state, 'foreign')
  assert.match(r.message, /occupied by another program/i)
  assert.match(r.message, /7789/)
  assert.match(r.message, /Settings/i) // retry guidance points at the desktop settings
  assert.equal(r.bad, true)
})

test('port-moved: the real door answering on a different port is surfaced with the actual port', () => {
  const r = classifyDoorProbe({ endpoint: 'http://127.0.0.1:7789/capture', status: 401, headers: { [DOOR_HEADER]: '1', [PORT_HEADER]: '7791' } })
  assert.equal(r.state, 'port-moved')
  assert.match(r.message, /7791/)
  assert.match(r.message, /7789/)
  assert.equal(r.bad, true)
})

test('ok: the door header on the configured port means the delivery path is live', () => {
  const r = classifyDoorProbe({ endpoint: 'http://127.0.0.1:7789/capture', status: 401, headers: { [DOOR_HEADER]: '1', [PORT_HEADER]: '7789' } })
  assert.equal(r.state, 'ok')
  assert.equal(r.bad, false)
  assert.match(r.message, /connected/i)
})

test('ok even when the door header carries no port (older desktop): identity header alone is trusted', () => {
  const r = classifyDoorProbe({ endpoint: 'http://127.0.0.1:7789/capture', status: 401, headers: { [DOOR_HEADER]: '1' } })
  assert.equal(r.state, 'ok')
})
