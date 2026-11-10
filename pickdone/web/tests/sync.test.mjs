import test from 'node:test'
import assert from 'node:assert/strict'

import { taskToDto, taskFromDto, episodeToDto, episodeFromDto, categoryToDto, categoryFromDto } from '../src/sync/dto-mapping.js'
import { pairDesktop, createBridgeClient } from '../src/sync/bridge-client.js'
import { inboundVerdict, mergePull, planPush, summarizePushResults, VERDICTS, ENTITY_TO_STORE } from '../src/sync/sync-engine.js'

const BASE = 'http://127.0.0.1:52119'
const TOKEN = 'eyJkZXZpY2UiOiJ3ZWIifQ.sig'

function fakeFetch(responder) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return responder(calls.length, url, init)
  }
  fn.calls = calls
  return fn
}

function okRes(body) {
  return { ok: true, status: 200, json: async () => body }
}

// ---- DTO mapping: exact Lane A alias contract ----

test('task rows map to the desktop DTO aliases and back (unknown fields preserved)', () => {
  const row = { id: 't1', content: 'Write spec', description: '', categoryId: 3, complete: 0, scheduledDay: 20261107, deadlineTs: 0, createdAt: 10, updatedAt: 20, deleted: 0, deletedAt: 0, syncAuthor: null, version: 2, localOnly: 'keep-me' }
  const dto = taskToDto(row)
  assert.equal(dto.taskId, 't1')
  assert.equal(dto.title, 'Write spec')
  assert.equal(dto.id, undefined)
  assert.equal(dto.content, undefined)
  assert.equal(dto.updatedAt, 20)
  assert.equal(dto.localOnly, undefined, 'outbound matches desktop dto.mjs: known columns only; client-private fields stay local')
  const back = taskFromDto(dto)
  assert.equal(back.id, 't1')
  assert.equal(back.content, 'Write spec')
  assert.equal(back.scheduledDay, 20261107)
  const withPrivate = taskFromDto({ ...dto, clientTag: 'private-1' })
  assert.equal(withPrivate.clientTag, 'private-1', 'inbound unknown fields are preserved verbatim')
})

test('episode and category aliases round trip; tombstones never dropped', () => {
  const ep = { id: 'e1', taskId: 't1', note: 'step A', startedAt: 1, endedAt: 2, updatedAt: 5, deleted: 0, deletedAt: 0 }
  const epDto = episodeToDto(ep)
  assert.equal(epDto.episodeId, 'e1')
  assert.equal(epDto.summary, 'step A')
  const epBack = episodeFromDto(epDto)
  assert.equal(epBack.id, 'e1')
  assert.equal(epBack.note, 'step A')
  assert.equal(epBack.taskId, 't1')
  const cat = { id: 5, name: 'Apollo', color: '#7a9e65', isFolder: 0, parentId: 0, updatedAt: 7, deleted: 0, deletedAt: 0 }
  const catBack = categoryFromDto(categoryToDto(cat))
  assert.equal(catBack.id, 5)
  assert.equal(catBack.name, 'Apollo')
  assert.equal(catBack.isProject, undefined, 'desktop view flag must not become a persisted column')
  const tombDto = episodeToDto({ ...ep, deleted: 1, deletedAt: 99 })
  assert.equal(episodeFromDto(tombDto).deletedAt, 99)
  assert.throws(() => taskFromDto({ taskId: 'x' }), /title/)
})

// ---- scheduledDay unit contract: desktop column = local day-start epoch ms,
// web canonical = yyyymmdd integer. The DTO layer is the unit boundary. ----

test('pull: desktop epoch-ms scheduledDay maps to the web yyyymmdd day key (FAIL-2 red)', () => {
  const dayStart = new Date(2026, 10, 10).getTime()          // 2026-11-10 00:00 local
  const row = taskFromDto({ taskId: 'd1', title: 'From desktop', scheduledDay: dayStart, updatedAt: 1 })
  assert.equal(row.scheduledDay, 20261110, 'desktop ms day-start must land as yyyymmdd so the web Today filter matches')
  // late-evening timestamps on the same wall-clock day keep the same key (cross-day boundary)
  const lateNight = new Date(2026, 10, 10, 23, 59).getTime()
  assert.equal(taskFromDto({ taskId: 'd2', title: 'x', scheduledDay: lateNight, updatedAt: 1 }).scheduledDay, 20261110)
  const nextDay = new Date(2026, 10, 11, 0, 1).getTime()
  assert.equal(taskFromDto({ taskId: 'd3', title: 'x', scheduledDay: nextDay, updatedAt: 1 }).scheduledDay, 20261111)
})

test('pull: an already-yyyymmdd scheduledDay (web echo) passes through unchanged', () => {
  const row = taskFromDto({ taskId: 'w1', title: 'Echo', scheduledDay: 20261110, updatedAt: 1 })
  assert.equal(row.scheduledDay, 20261110)
})

test('pull: empty/absent scheduledDay stays empty', () => {
  assert.equal(taskFromDto({ taskId: 'e1', title: 'x', scheduledDay: 0, updatedAt: 1 }).scheduledDay, 0)
  assert.equal('scheduledDay' in taskFromDto({ taskId: 'e2', title: 'x', updatedAt: 1 }), false)
})

test('push: web yyyymmdd scheduledDay maps to desktop local day-start epoch ms (FAIL-2 red)', () => {
  const dto = taskToDto({ id: 'w2', content: 'To desktop', scheduledDay: 20261110, updatedAt: 1 })
  assert.equal(dto.scheduledDay, new Date(2026, 10, 10).getTime(), 'desktop column is epoch ms; a raw yyyymmdd would land in 1970')
})

test('scheduledDay round trip is stable in both directions', () => {
  const dayStart = new Date(2026, 10, 10).getTime()
  const webRow = taskFromDto({ taskId: 'r1', title: 'x', scheduledDay: dayStart, updatedAt: 1 })
  const echoedDto = taskToDto(webRow)
  assert.equal(echoedDto.scheduledDay, dayStart, 'web->desktop->echo restores the same ms instant')
  assert.equal(taskFromDto(echoedDto).scheduledDay, 20261110)
})

// ---- pairing + client transport ----

test('pairDesktop exchanges the one-time challenge for scoped credentials', async () => {
  const fetch = fakeFetch(() => okRes({ ok: true, token: TOKEN, csrfHeader: 'nonce-1', expiresAt: 9999999999999, scope: 'WRITE', deviceId: 'web-1' }))
  const creds = await pairDesktop({ baseUrl: BASE, challengeId: 'ch-1', code: '123456', deviceId: 'web-1', fetchImpl: fetch })
  assert.equal(creds.token, TOKEN)
  assert.equal(creds.csrf, 'nonce-1')
  assert.equal(creds.scope, 'WRITE')
  assert.equal(fetch.calls[0].url, BASE + '/crossplatform/pair')
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { challengeId: 'ch-1', code: '123456', deviceId: 'web-1' })
})

test('pairDesktop surfaces the machine-readable failure (expired/burned/bad code)', async () => {
  const fetch = fakeFetch(() => ({ ok: false, status: 410, json: async () => ({ ok: false, error: 'challenge_burned' }) }))
  await assert.rejects(
    () => pairDesktop({ baseUrl: BASE, challengeId: 'ch-1', code: '1', deviceId: 'web-1', fetchImpl: fetch }),
    /challenge_burned/
  )
})

const CREDS = { token: TOKEN, csrf: 'nonce-1', expiresAt: Infinity, scope: 'WRITE', deviceId: 'web-1' }

test('pull sends the full gated envelope (bearer, CSRF header, payload, fresh messageId)', async () => {
  const fetch = fakeFetch(() => okRes({ ok: true, result: { entities: { todos: [] }, pulledAt: 1 } }))
  const client = createBridgeClient({ baseUrl: BASE, credentials: CREDS, deviceId: 'web-1', fetchImpl: fetch })
  const result = await client.pull()
  const init = fetch.calls[0].init
  assert.equal(fetch.calls[0].url, BASE + '/crossplatform/pull')
  assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN)
  assert.equal(init.headers['X-PickDone-Request'], 'nonce-1')
  const body = JSON.parse(init.body)
  assert.deepEqual(body.payload, {})
  assert.equal(body.deviceId, 'web-1')
  assert.ok(body.messageId)
  assert.deepEqual(result.entities.todos, [])
})

test('push carries ops[] and enforces WRITE scope client-side', async () => {
  const fetch = fakeFetch(() => okRes({ ok: true, result: { results: [{ entity: 'todos', outcomes: [{ verdict: 'applied' }] }] } }))
  const client = createBridgeClient({ baseUrl: BASE, credentials: CREDS, deviceId: 'web-1', fetchImpl: fetch })
  const out = await client.push([{ entity: 'todos', rows: [taskToDto({ id: 't9', content: 'X', updatedAt: 1 })] }])
  const body = JSON.parse(fetch.calls[0].init.body)
  assert.deepEqual(body.payload.ops[0].entity, 'todos')
  assert.equal(body.payload.ops[0].rows[0].taskId, 't9')
  assert.equal(out.results[0].outcomes[0].verdict, 'applied')
  const readOnly = createBridgeClient({ baseUrl: BASE, credentials: { ...CREDS, scope: 'READ' }, deviceId: 'web-1', fetchImpl: fetch })
  await assert.rejects(() => readOnly.push([{ entity: 'todos', rows: [] }]), /WRITE scope/)
  // READ clients can still pull
  await readOnly.pull()
})

test('client fails closed on missing/expired credentials and surfaces retryAfterMs', async () => {
  const fetch = fakeFetch(() => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited', retryAfterMs: 4321 }) }))
  const none = createBridgeClient({ baseUrl: BASE, credentials: null, deviceId: 'web-1', fetchImpl: fetch })
  await assert.rejects(() => none.pull(), /Pairing credentials required/)
  const expired = createBridgeClient({ baseUrl: BASE, credentials: { ...CREDS, expiresAt: 1 }, deviceId: 'web-1', fetchImpl: fetch, now: () => 2 })
  await assert.rejects(() => expired.pull(), /expired/)
  const client = createBridgeClient({ baseUrl: BASE, credentials: CREDS, deviceId: 'web-1', fetchImpl: fetch })
  await assert.rejects(async () => {
    try { await client.pull() } catch (e) { assert.equal(e.code, 'rate_limited'); assert.equal(e.retryAfterMs, 4321); throw e }
  }, /rate_limited/)
})

// ---- pure engine: merge / plan / summarize ----

const NOW = 1000
function taskRow(id, updatedAt, extra = {}) {
  return { id, content: 'C-' + id, updatedAt, deleted: 0, deletedAt: 0, ...extra }
}

test('mergePull: applied, idempotent, stale and poison rows', () => {
  const localTasks = [taskRow('a', NOW), taskRow('b', NOW + 10)]
  const entities = {
    todos: [
      taskToDto(taskRow('a', NOW)),                       // idempotent_skip
      taskToDto(taskRow('a', NOW + 5)),                   // applied (newer)
      taskToDto(taskRow('b', NOW)),                       // stale_skip (local newer)
      { title: 'x', updatedAt: NOW },                     // poison (no taskId) -> skipped
      { taskId: '', title: 'x', updatedAt: NOW }          // poison (blank id) -> skipped
    ]
  }
  const { changes, conflicts, skipped } = mergePull({ tasks: localTasks, projects: [], episodes: [] }, entities)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].store, 'tasks')
  assert.equal(changes[0].row.id, 'a')
  assert.equal(changes[0].row.updatedAt, NOW + 5)
  assert.deepEqual(conflicts, [])
  assert.equal(skipped, 4)
})

test('mergePull: tombstone vs edit conflicts are surfaced with both sides, never silent', () => {
  const localTasks = [taskRow('a', NOW)]
  const win = mergePull({ tasks: localTasks }, { todos: [taskToDto(taskRow('a', NOW + 1, { deleted: 1, deletedAt: NOW + 1 }))] })
  assert.equal(win.changes.length, 1)
  assert.equal(win.conflicts[0].verdict, VERDICTS.CONFLICT_TOMBSTONE_WINS)
  assert.equal(win.conflicts[0].local.updatedAt, NOW)
  const lose = mergePull({ tasks: [taskRow('a', NOW, { deleted: 1 })] }, { todos: [taskToDto(taskRow('a', NOW + 1))] })
  assert.equal(lose.conflicts[0].verdict, VERDICTS.CONFLICT_EDIT_WINS)
})

test('inboundVerdict matches the desktop dto-service truth table', () => {
  assert.equal(inboundVerdict(null, { id: 'x', updatedAt: 1 }), VERDICTS.APPLIED)
  assert.equal(inboundVerdict({ id: 'x', updatedAt: 5 }, { id: 'x', updatedAt: 5 }), VERDICTS.IDEMPOTENT_SKIP)
  assert.equal(inboundVerdict({ id: 'x', updatedAt: 6 }, { id: 'x', updatedAt: 5 }), VERDICTS.STALE_SKIP)
  assert.equal(inboundVerdict({ id: 'x', updatedAt: 5 }, { id: 'x', updatedAt: 6, deleted: 1 }), VERDICTS.CONFLICT_TOMBSTONE_WINS)
  assert.equal(inboundVerdict({ id: 'x', updatedAt: 5, deleted: 1 }, { id: 'x', updatedAt: 6 }), VERDICTS.CONFLICT_EDIT_WINS)
  assert.equal(inboundVerdict({ id: 'x', updatedAt: 5 }, { id: '', updatedAt: 6 }), VERDICTS.REJECTED)
})

test('planPush: full snapshot in contract order, chunked at 500, poison rows dropped', () => {
  const tasks = Array.from({ length: 501 }, (_, i) => taskRow('t' + i, i))
  tasks.push({ id: '', content: 'poison' })
  const { ops } = planPush({ tasks, projects: [], episodes: [] })
  const todoOps = ops.filter(o => o.entity === 'todos')
  assert.equal(todoOps.length, 2)
  assert.equal(todoOps[0].rows.length, 500)
  assert.equal(todoOps[1].rows.length, 1)
  const allIds = todoOps.flatMap(o => o.rows.map(r => r.taskId))
  assert.ok(!allIds.includes(''), 'poison row must not enter the wire batch')
  assert.equal(ops.some(o => o.entity === 'categories'), false, 'empty collections produce no ops')
  // empty local state -> nothing on the wire
  assert.deepEqual(planPush({ tasks: [], projects: [], episodes: [] }).ops, [])
})

test('summarizePushResults counts verdicts and lifts conflicts', () => {
  const { counts, conflicts } = summarizePushResults([
    { entity: 'todos', outcomes: [{ verdict: 'applied' }, { verdict: 'idempotent_skip' }, { verdict: 'conflict_tombstone_wins', conflict: { id: 'z', winner: 'delete' } }] },
    { entity: 'categories', outcomes: [{ verdict: 'stale_skip' }] }
  ])
  assert.equal(counts.applied, 1)
  assert.equal(counts.idempotent_skip, 1)
  assert.equal(counts.conflict_tombstone_wins, 1)
  assert.deepEqual(conflicts, [{ entity: 'todos', id: 'z', winner: 'delete' }])
})

test('entity<->store mapping covers the three web collections', () => {
  assert.deepEqual(Object.values(ENTITY_TO_STORE).sort(), ['episodes', 'projects', 'tasks'])
})
