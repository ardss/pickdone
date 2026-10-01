/* D14 C13 regression — pairing client: a silent peer close settles the promise fast as a
 * rejection instead of hanging to the 63s client deadline, and a trailing close after settle
 * (done() itself closes the socket) never double-settles. Covers both pairWith and requestPair.
 * Run: node --test tests/unit/lan-sync/d14-c13-pairing-close.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

function stubPairingTransport () {
  const fakeConns = []
  const stub = {
    connect: (host, port, opts) => {
      const em = new EventEmitter()
      em.ready = false
      em.send = () => true
      em.close = () => { setImmediate(() => em.emit('close')) }
      fakeConns.push(em)
      return em
    },
    DEFAULT_PORT: 58471,
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === './transport' && parent && String(parent.filename || '').includes('pairing-client.js')) return stub
    return origLoad.call(this, request, parent, isMain)
  }
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/pairing-client.js'))
  delete require_.cache[resolved]
  try { return { mod: require_(resolved), fakeConns } } finally { Module._load = origLoad }
}

test('C13: a silent peer close rejects fast instead of hanging to the 63s deadline', async () => {
  const { mod, fakeConns } = stubPairingTransport()
  const peers = new Map([['peerX', { deviceId: 'peerX', host: '10.0.0.9', port: 58471 }]])
  const node = mod.createPairingClient({ peers, deviceId: 'me', name: 'me', em: new EventEmitter() })
  const t0 = Date.now()
  const p = node.requestPair('10.0.0.9', 58471)
  await new Promise(r => setImmediate(r))
  // the peer accepts TCP then dies without ever sending a frame:
  fakeConns[fakeConns.length - 1].emit('close')
  await assert.rejects(
    () => p,
    err => /peer closed the connection/.test(err.message),
    'close-without-frame is a fast rejection'
  )
  assert.ok(Date.now() - t0 < 5000, `settled fast (took ${Date.now() - t0}ms; red before the fix: sat until the 63s deadline)`)
  assert.equal(fakeConns.length, 1)
})

test('C13: pairWith rejects on close, and a trailing close never double-settles a paired result', async () => {
  const { mod, fakeConns } = stubPairingTransport()
  const peers = new Map([['peerX', { deviceId: 'peerX', host: '10.0.0.9', port: 58471 }]])
  const node = mod.createPairingClient({ peers, deviceId: 'me', name: 'me', em: new EventEmitter() })
  // happy path first: paired fires, then done() closes the socket — the trailing 'close' event
  // must NOT clobber the settled resolution
  const p = node.pairWith('peerX', '123456')
  await new Promise(r => setImmediate(r))
  const conn = fakeConns[fakeConns.length - 1]
  conn.emit('paired', { secret: 'sec-1' })
  await p.then(r => assert.deepEqual({ secret: r.secret }, { secret: 'sec-1' }), () => assert.fail('paired flow must resolve'))
  // close-rejection path: a fresh pairWith whose peer closes without answering
  const p2 = node.pairWith('peerX', '123456')
  await new Promise(r => setImmediate(r))
  fakeConns[fakeConns.length - 1].emit('close')
  await assert.rejects(() => p2, err => /peer closed the connection/.test(err.message))
})
