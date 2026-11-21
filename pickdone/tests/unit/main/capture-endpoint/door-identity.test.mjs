// J3 sentinel (qa-r7 P1) — door IDENTITY headers. A silent EADDRINUSE fallback to 7789+1
// left both ends blind: the extension kept posting to a port held by a stranger and the user
// saw nothing. Every door answer now carries `X-PickDone-Door: 1` + `X-PickDone-Port: <n>`
// so any client (extension popup probe, VS Code extension) can prove it is talking to the
// REAL PickDone door and learn the actual port. Red-first: these headers did not exist.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { startCaptureServer } from '../../../../src/main/capture-endpoint/server.js'
import { generateKey, KEY_HEADER } from '../../../../src/main/capture-endpoint/secret.js'

function request (port, path, { method = 'GET', key } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: key != null ? { [KEY_HEADER]: key } : {}
    }, res => {
      const headers = { ...res.headers }
      // node lower-cases header names; expose canonical for assertions via raw cast
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('every door answer carries the identity headers (401 pre-auth, 404 unknown path, 204 preflight)', async () => {
  const secret = generateKey()
  const handle = startCaptureServer({ port: 0, attempts: 3, getSecret: () => secret, isEnabled: () => true })
  after(() => handle.close())
  const port = await handle.ready
  for (const [method, path, key] of [
    ['GET', '/tasks', undefined],            // 401: gate order keeps auth before any db touch
    ['GET', '/nope', secret],                // 404: route existence pre-auth
    ['OPTIONS', '/capture', undefined]       // 204: CORS preflight
  ]) {
    const r = await request(port, path, { method, key })
    assert.equal(String(r.headers['x-pickdone-door']), '1', `door header missing on ${method} ${path} (${r.status})`)
    assert.equal(String(r.headers['x-pickdone-port']), String(port), `port header mismatch on ${method} ${path}`)
  }
})

test('after an EADDRINUSE fallback the port header names the ACTUAL bound port (the sentinel fact)', async () => {
  const probe = net.createServer(); await new Promise(r => { probe.listen(0, '127.0.0.1', r) })
  const base = probe.address().port
  probe.close() // free the probe handle; the BLOCKER now holds the port so the door must fall back
  const blocker = net.createServer(); await new Promise(r => { blocker.listen(base, '127.0.0.1', r) })
  after(() => blocker.close())
  const secret = generateKey()
  const handle = startCaptureServer({ port: base, attempts: 5, getSecret: () => secret, isEnabled: () => true })
  after(() => handle.close())
  const bound = await handle.ready
  assert.notEqual(bound, base, 'expected a fallback port')
  const r = await request(bound, '/tasks')
  assert.equal(r.status, 401)
  assert.equal(String(r.headers['x-pickdone-port']), String(bound))
  assert.notEqual(String(r.headers['x-pickdone-port']), String(base))
})
