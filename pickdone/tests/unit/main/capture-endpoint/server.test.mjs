/**
 * [S4 capture-endpoint RED→GREEN] server.js — the real HTTP surface, driven with a pure-Node
 * http client (no electron, no real db — the command bus and meta reads are injected fakes,
 * exactly the seam the main-process wiring uses).
 *
 * Behavior under test (red-line 4: user/attacker-visible):
 *   - POST /capture with NO key header → 401 and ZERO db writes;
 *   - POST /capture with a WRONG key → 401 and ZERO db writes;
 *   - correct key + valid payload → 201 with a taskId, and the task/SourceRef actually landed
 *     through the command bus (fake db sees upsert + setMetaMany);
 *   - re-sending the same dedupeFingerprint → 200 duplicate, no second row;
 *   - port 7789 already occupied → falls back to 7789+1 and exposes the actual port;
 *   - disabled switch → 503; wrong path / wrong method → 404; broken JSON → 400;
 *   - regenerating the secret (getSecret now returns a new key) makes the OLD key 401.
 *
 * Run: node --test tests/unit/main/capture-endpoint/server.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { startCaptureServer } from '../../../../src/main/capture-endpoint/server.js'
import { ingestCapture } from '../../../../src/main/capture-endpoint/handlers.js'
import { generateKey, KEY_HEADER } from '../../../../src/main/capture-endpoint/secret.js'

/* ---------- harness ---------- */

function makeDb () {
  const ops = []
  const meta = new Map()
  let srcSeq = 0
  return {
    ops,
    meta,
    dbCall (op, params) {
      ops.push([op, params])
      if (op === 'setMetaMany') { for (const [k, v] of params) meta.set(String(k), String(v)); return params.length }
      if (op === 'getMeta') return meta.has(params) ? meta.get(params) : null
      if (op === 'upsert') return true
      if (op === 'sourcePut') return 'src_test_' + (++srcSeq)
      if (op === 'taskSourcePut') return 'tsl_test'
      throw new Error('unexpected op ' + op)
    },
    getMeta: k => (meta.has(k) ? meta.get(k) : null)
  }
}

/** A bus-shaped adapter routing the capture commands onto the fake db layer (same routing the
 *  real manifest gives: todo.put→upsert, source.put→sourcePut, tasksource.put→taskSourcePut,
 *  capture.ingest→setMetaMany). */
function fakeBusAdapter (db) {
  let srcSeq = 0
  return {
    commit (entity, verb, payload) {
      if (entity === 'todo' && verb === 'put') return db.dbCall('upsert', payload)
      if (entity === 'source' && verb === 'put') return db.dbCall('sourcePut', payload) && 'src_test_' + (++srcSeq)
      if (entity === 'tasksource' && verb === 'put') return db.dbCall('taskSourcePut', payload)
      if (entity === 'capture' && verb === 'ingest') return db.dbCall('setMetaMany', payload)
      throw new Error('unexpected command ' + entity + '.' + verb)
    }
  }
}

function makeServer ({ port = 0, enabled = true, db = makeDb() } = {}) {
  let secret = generateKey()
  const handle = startCaptureServer({
    port,
    attempts: 10,
    getMeta: db.getMeta,
    getSecret: () => secret,
    isEnabled: () => enabled,
    ingest: (payload) => ingestCapture({ bus: fakeBusAdapter(db), getMeta: db.getMeta, payload })
  })
  return { handle, db, setSecret: s => { secret = s }, getSecretNow: () => secret }
}

function post (port, path, { key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...(key != null ? { [KEY_HEADER]: key } : {})
      }
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(buf) } catch { /* non-json body */ }
        resolve({ status: res.statusCode, json, raw: buf })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

const request = (port, path, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET' }, res => {
    res.resume()
    res.on('end', () => resolve({ status: res.statusCode }))
  })
  req.on('error', reject)
  req.end()
})

/* ---------- tests ---------- */

test('no key header → 401 and nothing written to the db', async () => {
  const { handle, db } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  const r = await post(handle.actualPort, '/capture', { body: { content: 'x' } })
  assert.equal(r.status, 401)
  assert.equal(db.ops.length, 0, 'a keyless request must never touch the db')
})

test('wrong key → 401 and nothing written to the db', async () => {
  const { handle, db } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  const r = await post(handle.actualPort, '/capture', { key: generateKey(), body: { content: 'x' } })
  assert.equal(r.status, 401)
  assert.equal(db.ops.length, 0)
})

test('correct key + valid payload → 201; task row + SourceRef/TaskSourceLink landed through the bus', async () => {
  const { handle, db, getSecretNow } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  const r = await post(handle.actualPort, '/capture', {
    key: getSecretNow(),
    body: { content: 'hello from the browser', dedupeFingerprint: 'fp-live-1', sourceUrl: 'https://example.com/a', sourceTitle: 'A' }
  })
  assert.equal(r.status, 201)
  assert.match(r.json.taskId, /^cap-[0-9a-f]{16}$/)
  const todoOps = db.ops.filter(([op]) => op === 'upsert')
  assert.equal(todoOps.length, 1, 'exactly one todo row')
  assert.equal(todoOps[0][1].taskContent, 'hello from the browser')
  assert.equal(todoOps[0][1].categoryId, 0, 'inbox mode: no category')
  const pairs = Object.fromEntries(db.ops.find(([op]) => op === 'setMetaMany')[1])
  const linked = JSON.parse(pairs['taskSourceLink:fp-live-1'])
  assert.equal(linked.taskId, r.json.taskId, 'dedupe pair maps the fingerprint to the task')
  assert.match(linked.sourceRefId, /^src_test_\d+$/, 'SourceRef row id is in the pair')
  assert.ok(db.ops.find(([op]) => op === 'sourcePut'), 'a source_refs row was written')
  assert.ok(db.ops.find(([op]) => op === 'taskSourcePut'), 'a task_source_links row was written')
})

test('same dedupeFingerprint re-sent over HTTP → 200 duplicate, still one row', async () => {
  const { handle, db, getSecretNow } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  const body = { content: 'dup me', dedupeFingerprint: 'fp-live-2' }
  const first = await post(handle.actualPort, '/capture', { key: getSecretNow(), body })
  const second = await post(handle.actualPort, '/capture', { key: getSecretNow(), body })
  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.taskId, first.json.taskId)
  assert.equal(db.ops.filter(([op]) => op === 'upsert').length, 1, 'no second row')
})

test('port already occupied → falls back to port+1 and exposes the actual port', async t => {
  const blocker = net.createServer()
  await new Promise(resolve => blocker.listen(7789, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  const { handle, getSecretNow } = makeServer({ port: 7789 })
  after(() => handle.server.close())
  await handle.ready
  assert.equal(handle.actualPort, 7790, 'capture endpoint landed on 7789+1')
  const r = await post(7790, '/capture', { key: getSecretNow(), body: { content: 'via fallback port' } })
  assert.equal(r.status, 201)
})

test('disabled switch → 503 regardless of key', async () => {
  const { handle, getSecretNow } = makeServer({ enabled: false })
  after(() => handle.server.close())
  await handle.ready
  const r = await post(handle.actualPort, '/capture', { key: getSecretNow(), body: { content: 'x' } })
  assert.equal(r.status, 503)
})

test('wrong path and wrong method → 404; broken JSON → 400', async () => {
  const { handle, getSecretNow } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  assert.equal((await request(handle.actualPort, '/capture')).status, 404, 'GET /capture is not the door')
  assert.equal((await request(handle.actualPort, '/other', { method: 'POST' })).status, 404)
  const bad = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: handle.actualPort, path: '/capture', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 3, [KEY_HEADER]: getSecretNow() }
    }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })) })
    req.on('error', reject)
    req.end('{no')
  })
  assert.equal(bad.status, 400)
})

test('regenerated secret: the OLD key stops working (401), the NEW key is 201', async () => {
  const { handle, db, setSecret, getSecretNow } = makeServer()
  after(() => handle.server.close())
  await handle.ready
  const oldKey = getSecretNow()
  const body = { content: 'after regen', dedupeFingerprint: 'fp-regen-1' }
  assert.equal((await post(handle.actualPort, '/capture', { key: oldKey, body })).status, 201)
  setSecret(generateKey()) // the settings tab "regenerate" button wrote a new key
  assert.equal(
    (await post(handle.actualPort, '/capture', { key: oldKey, body: { content: 'x2', dedupeFingerprint: 'fp-regen-2' } })).status,
    401, 'old key now rejected'
  )
  const fresh = await post(handle.actualPort, '/capture', { key: getSecretNow(), body: { content: 'after regen 2', dedupeFingerprint: 'fp-regen-3' } })
  assert.equal(fresh.status, 201, 'new key accepted')
  void db
})
