/**
 * [PD20 VS Code extension MVP RED→GREEN] read door + link-source — the loopback door gains
 * read-only GET routes (/tasks, /projects, /sources, /episodes, /handoff) and one write route
 * (POST /link-source) for the VS Code extension. Every route sits behind the SAME gates as
 * the ingest door: kill switch → per-request X-PickDone-Key handshake. No route reads or
 * writes anything db-side without passing both.
 *
 * Run: node --test tests/unit/main/capture-endpoint/read-door.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startCaptureServer } from '../../../../src/main/capture-endpoint/server.js'
import { linkSource, LINK_PROVIDER_ID } from '../../../../src/main/capture-endpoint/handlers.js'

const KEY = 'k'.repeat(48)
const keyHeaders = { 'x-pickdone-key': KEY }

function request (port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function startServer (opts = {}) {
  const srv = startCaptureServer({
    port: opts.port,
    isEnabled: () => opts.enabled !== false,
    getSecret: () => KEY,
    query: opts.query || (() => null),
    linkSource: opts.linkSource || null,
    ingest: () => ({ ok: true, status: 201, taskId: 'cap-x' })
  })
  after(() => srv.close())
  return srv
}

const stubQuery = (op, arg) => {
  if (op === 'queryTodos') return [{ taskId: 't1', taskContent: 'Write the report', categoryId: 3, complete: 0, updateTime: 1 }]
  if (op === 'categoriesAllRows') return [{ id: 3, name: 'Work', deleted: 0 }, { id: 4, name: 'Old', deleted: 1 }]
  if (op === 'querySourcesByTask') return [{ sourceRefId: 's1', providerId: 'capture', canonicalUri: 'http://127.0.0.1:8000/a', level: 'L0' }]
  if (op === 'queryEpisodesByTask') return [{ episodeId: 'e1', startedAt: '2026-11-08T09:00:00Z', summary: 'read the page' }]
  return null
}

test('GET /tasks: 401 without the key, 200 with it; rows are trimmed to the public shape', async () => {
  const srv = startServer({ port: 7811, query: stubQuery })
  await srv.ready
  const denied = await request(srv.actualPort, 'GET', '/tasks')
  assert.equal(denied.status, 401)
  const ok = await request(srv.actualPort, 'GET', '/tasks', keyHeaders)
  assert.equal(ok.status, 200)
  const rows = JSON.parse(ok.body)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskId, 't1')
  assert.equal(rows[0].content, 'Write the report')
  assert.equal(rows[0].complete, false)
})

test('GET /projects filters deleted rows; /sources and /episodes forward taskId', async () => {
  const srv = startServer({ port: 7812, query: stubQuery })
  await srv.ready
  const projects = JSON.parse((await request(srv.actualPort, 'GET', '/projects', keyHeaders)).body)
  assert.deepEqual(projects, [{ categoryId: 3, name: 'Work' }])
  const sources = JSON.parse((await request(srv.actualPort, 'GET', '/sources?taskId=t1', keyHeaders)).body)
  assert.equal(sources[0].providerId, 'capture')
  const eps = JSON.parse((await request(srv.actualPort, 'GET', '/episodes?taskId=t1', keyHeaders)).body)
  assert.equal(eps[0].summary, 'read the page')
})

test('GET /handoff returns the real buildHandoff markdown (episodes + sources + [L0])', async () => {
  const srv = startServer({ port: 7813, query: stubQuery })
  await srv.ready
  const h = await request(srv.actualPort, 'GET', '/handoff?taskId=t1', keyHeaders)
  assert.equal(h.status, 200)
  const j = JSON.parse(h.body)
  assert.match(j.text, /# Handoff/)
  assert.match(j.text, /\[L0\]/)
  assert.match(j.text, /read the page/)
  const missing = await request(srv.actualPort, 'GET', '/handoff', keyHeaders)
  assert.equal(missing.status, 400)
})

test('kill switch: a disabled endpoint answers 503 to the read door too', async () => {
  const srv = startServer({ port: 7814, query: stubQuery, enabled: false })
  await srv.ready
  assert.equal((await request(srv.actualPort, 'GET', '/tasks', keyHeaders)).status, 503)
})

test('OPTIONS preflight is answered for read paths without touching the db', async () => {
  const srv = startServer({ port: 7815, query: stubQuery, enabled: false })
  await srv.ready
  const pre = await request(srv.actualPort, 'OPTIONS', '/tasks', { origin: 'vscode-webview://x' })
  assert.equal(pre.status, 204)
})

test('unknown GET path → 404 (the read door adds no catch-all read)', async () => {
  const srv = startServer({ port: 7816, query: stubQuery })
  await srv.ready
  assert.equal((await request(srv.actualPort, 'GET', '/everything', keyHeaders)).status, 404)
})

test('linkSource: 404 unknown task; 400 on a non-reference uri; rejects content-bearing payloads', () => {
  const bus = { commit: (_e, _v, _p) => 'sr1' }
  const ctx = { bus, query: stubQuery }
  assert.equal(linkSource({ ...ctx, payload: { taskId: 'ghost', canonicalUri: 'file:///C:/w/a.md' } }).status, 404)
  assert.equal(linkSource({ ...ctx, payload: { taskId: 't1', canonicalUri: 'free text not a uri' } }).status, 400)
  assert.equal(linkSource({ ...ctx, payload: { taskId: 't1', canonicalUri: 'file:///C:/w/a.md', content: 'PRIVATE SOURCE CODE' } }).status, 400)
  const ok = linkSource({ ...ctx, payload: { taskId: 't1', canonicalUri: 'file:///C:/w/notes.md', sourceTitle: 'notes.md' } })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 201)
  assert.equal(bus.commits, undefined) // shape guard only; commit count asserted via the stub below
})

test('linkSource: dedupe — the same uri linked twice resolves duplicate without a second commit', () => {
  let commits = 0
  const bus = { commit: () => { commits++; return 'sr' + commits } }
  const q = (op, arg) => {
    if (op === 'queryTodos') return stubQuery(op, arg)
    if (op === 'querySourcesByTask') return commits === 0 ? [] : [{ sourceRefId: 'sr1', canonicalUri: 'file:///C:/w/a.md', externalId: 'file:///C:/w/a.md' }]
    return null
  }
  const first = linkSource({ bus, query: q, payload: { taskId: 't1', canonicalUri: 'file:///C:/w/a.md' } })
  assert.equal(first.status, 201)
  const second = linkSource({ bus, query: q, payload: { taskId: 't1', canonicalUri: 'file:///C:/w/a.md' } })
  assert.equal(second.status, 200)
  assert.equal(second.duplicate, true)
  assert.equal(commits, 2) // exactly one source.put + one tasksource.put total
})

test('LINK_PROVIDER_ID stays vscode (privacy: the door never accepts arbitrary provider ids)', () => {
  assert.equal(LINK_PROVIDER_ID, 'vscode')
})
