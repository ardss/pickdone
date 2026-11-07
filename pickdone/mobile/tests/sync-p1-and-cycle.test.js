import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openRepository } from '../src/repository.js'
import { taskToDto, taskFromDto, episodeFromDto, inboundVerdict, VERDICTS } from '../src/sync/pair-contract.js'
import { mergePull, planPush, summarizePushResults } from '../src/sync/sync-cycle.js'
import { pairDesktop, createBridgeSession } from '../src/sync/pair-client.js'

// ---- QA 3411ddfe P1 #1: seed writes keep the peer's LWW stamps (no Date.now() reset) ----

test('first-sight seed write preserves the peer stamp, version and createdAt verbatim', async () => {
  const repo = await openRepository()
  const stamp = Date.now() + 60_000
  const seeded = await repo.saveTask({ id: 'seed-stamps', content: 'From desktop', updatedAt: stamp, createdAt: stamp - 5000, version: 47, syncAuthor: 'desktop' })
  assert.equal(seeded.updatedAt, stamp, 'seed must NOT mint Date.now() over the peer stamp')
  assert.equal(seeded.createdAt, stamp - 5000)
  assert.equal(seeded.version, 47)
  assert.equal(seeded.syncAuthor, 'desktop')
})

test('a LOCAL edit of the seeded row still mints a fresh newer stamp (+1 version)', async () => {
  const repo = await openRepository()
  const stamp = Date.now() - 120_000
  await repo.saveTask({ id: 'seed-then-edit', content: 'From desktop', updatedAt: stamp, version: 3 })
  const edited = await repo.saveTask({ id: 'seed-then-edit', content: 'Edited locally' })
  assert.ok(edited.updatedAt > stamp, 'local edit must advance the stamp')
  assert.equal(edited.version, 4)
})

// ---- QA 3411ddfe P1 #2: deletions propagate in (tombstone ingest + delete door) ----

test('seed write of a tombstoned peer row STAYS deleted (no silent resurrection)', async () => {
  const repo = await openRepository()
  const tombAt = Date.now() + 60_000
  const seeded = await repo.saveTask({ id: 'seed-tomb', content: 'Deleted on desktop', updatedAt: tombAt, deleted: 1, deletedAt: tombAt })
  assert.equal(seeded.deleted, 1)
  assert.equal(seeded.deletedAt, tombAt)
  assert.equal((await repo.tasks()).some(task => task.id === 'seed-tomb'), false, 'live view must hide the tombstone')
})

test('explicit delete door: saveTask({deleted:1}) tombstones a live row; editing it afterwards is refused', async () => {
  const repo = await openRepository()
  await repo.saveTask({ content: 'Will be deleted' })
  const live = (await repo.tasks()).find(task => task.content === 'Will be deleted')
  const tombAt = Date.now() + 60_000
  const deleted = await repo.saveTask({ id: live.id, content: live.content, deleted: 1, deletedAt: tombAt, updatedAt: tombAt })
  assert.equal(deleted.deleted, 1)
  assert.equal(deleted.deletedAt, tombAt)
  assert.equal((await repo.tasks()).some(task => task.id === live.id), false)
  await assert.rejects(() => repo.saveTask({ id: live.id, content: 'Revive?' }), /Deleted task cannot be edited/)
})

// ---- applyPulled door: verbatim stamps + tombstones, unknown fields preserved ----

test('applyPulled writes peer rows verbatim; sync-cycle mergePull honors LWW verdicts', async () => {
  const repo = await openRepository()
  await repo.saveTask({ content: 'Local live', categoryId: 0 })
  const localRows = await repo.rawAll('todos')
  const localById = new Map(localRows.map(row => [row.id, row]))

  const desktopTodoDto = { taskId: 'desk-1', title: 'From desktop', updatedAt: Date.now() + 60_000, clientTag: 'private-1' }
  const desktopTombDto = { taskId: 'desk-2', title: 'Tombstoned', updatedAt: Date.now() + 60_000, deleted: 1, deletedAt: Date.now() + 59_000 }
  const stale = taskToDto({ id: localRows[0].id, content: 'Stale overwrite attempt', updatedAt: 1 })
  const { changes, conflicts, skipped } = mergePull({ todos: localRows }, { todos: [desktopTodoDto, desktopTombDto, stale] })
  assert.equal(changes.length, 2)
  assert.deepEqual(conflicts, [])
  assert.equal(skipped, 1, 'stale desktop row must be skipped against the newer local stamp')
  for (const change of changes) await repo.applyPulled(change.entity, change.row)
  const raw = await repo.rawAll('todos')
  const tombRow = raw.find(row => row.id === 'desk-2')
  assert.equal(tombRow.deleted, 1)
  assert.equal(raw.find(row => row.id === 'desk-1').clientTag, 'private-1', 'unknown inbound fields survive the repo door')
  assert.equal((await repo.tasks()).some(task => task.id === 'desk-2'), false)
  // stale skip was NOT applied
  assert.equal((await repo.tasks()).find(task => task.id === localRows[0].id).content, 'Local live')
  // now a newer desktop tombstone against the live local row = surfaced conflict, tombstone wins
  const conflictBatch = mergePull({ todos: await repo.rawAll('todos') }, { todos: [taskToDto({ id: localRows[0].id, content: 'Local live', updatedAt: Date.now() + 90_000, deleted: 1, deletedAt: Date.now() + 89_000 })] })
  assert.equal(conflictBatch.changes.length, 1)
  assert.equal(conflictBatch.conflicts[0].verdict, VERDICTS.CONFLICT_TOMBSTONE_WINS)
  for (const change of conflictBatch.changes) await repo.applyPulled(change.entity, change.row)
  assert.equal((await repo.rawAll('todos')).find(row => row.id === localRows[0].id).deleted, 1)
})

test('planPush includes tombstones, chunks at 500, drops poison rows; summarize lifts conflicts', async () => {
  const repo = await openRepository()
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: 't' + i, content: 'C' + i, updatedAt: i, deleted: 0, deletedAt: 0 }))
  rows.push({ id: '', content: 'poison', updatedAt: 1 })
  const { ops } = planPush({ todos: rows, categories: [], work_episodes: [] })
  const todoOps = ops.filter(op => op.entity === 'todos')
  assert.equal(todoOps.length, 2)
  assert.equal(todoOps[0].rows.length, 500)
  assert.equal(todoOps[1].rows.length, 1)
  assert.ok(!todoOps.flatMap(op => op.rows).some(row => row.taskId === ''))
  assert.equal(ops.some(op => op.entity === 'categories'), false)
  // tombstones are pushed (desktop adjudicates), not filtered
  await repo.saveTask({ content: 'Doomed' })
  const live = (await repo.tasks()).find(task => task.content === 'Doomed')
  await repo.saveTask({ id: live.id, content: 'Doomed', deleted: 1, updatedAt: Date.now() + 60_000, deletedAt: Date.now() + 60_000 })
  const { ops: tombOps } = planPush({ todos: await repo.rawAll('todos'), categories: [], work_episodes: [] })
  assert.ok(tombOps[0].rows.some(row => row.taskId === live.id && row.deleted === 1))
  const { counts, conflicts } = summarizePushResults([{ entity: 'todos', outcomes: [{ verdict: 'applied' }, { verdict: 'stale_skip' }, { verdict: 'conflict_edit_wins', conflict: { id: 'x', winner: 'edit' } }] }])
  assert.equal(counts.applied, 1)
  assert.deepEqual(conflicts, [{ entity: 'todos', id: 'x', winner: 'edit' }])
  assert.ok(inboundVerdict({ updatedAt: 5 }, { updatedAt: 5 }) === VERDICTS.IDEMPOTENT_SKIP)
  assert.ok(episodeFromDto({ episodeId: 'e', taskId: 't', summary: 'n', updatedAt: 3 }).note === 'n')
})

// ---- real HTTP session vs df9c4aae route shapes ----

const BASE = 'http://127.0.0.1:52119'
function fakeFetch(responder) {
  const calls = []
  const fn = async (url, init) => { calls.push({ url, init }); return responder(calls.length, url, init) }
  fn.calls = calls
  return fn
}
const okRes = body => ({ ok: true, status: 200, json: async () => body })
const CREDS = { token: 'tok', csrfNonce: 'nonce', expiresAt: Infinity, scope: 'WRITE', deviceId: 'android-1' }

test('pairDesktop exchanges the one-shot challenge; failures surface machine codes', async () => {
  const fetch = fakeFetch(() => okRes({ ok: true, token: 'tok', csrfHeader: 'nonce', expiresAt: 9e15, scope: 'WRITE', deviceId: 'android-1' }))
  const creds = await pairDesktop({ baseUrl: BASE, challengeId: 'ch', code: '123456', deviceId: 'android-1', fetchImpl: fetch })
  assert.equal(creds.csrfNonce, 'nonce')
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { challengeId: 'ch', code: '123456', deviceId: 'android-1' })
  assert.equal(fetch.calls[0].url, BASE + '/crossplatform/pair')
  const bad = fakeFetch(() => ({ ok: false, status: 410, json: async () => ({ ok: false, error: 'challenge_burned' }) }))
  await assert.rejects(() => pairDesktop({ baseUrl: BASE, challengeId: 'ch', code: '1', deviceId: 'android-1', fetchImpl: bad }), /challenge_burned/)
})

test('bridge session sends the gated envelope; scope/expiry fail closed; retryAfterMs surfaces', async () => {
  const fetch = fakeFetch(() => okRes({ ok: true, result: { entities: { todos: [] }, pulledAt: 1 } }))
  const session = createBridgeSession({ baseUrl: BASE, credentials: CREDS, deviceId: 'android-1', fetchImpl: fetch })
  const pulled = await session.pull()
  const init = fetch.calls[0].init
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers['X-PickDone-Request'], 'nonce')
  const body = JSON.parse(init.body)
  assert.deepEqual(body.payload, {})
  assert.ok(body.messageId)
  assert.equal(body.deviceId, 'android-1')
  assert.deepEqual(pulled.entities.todos, [])
  await session.push([{ entity: 'todos', rows: [{ taskId: 't1', title: 'X', updatedAt: 1 }] }])
  const pushBody = JSON.parse(fetch.calls[1].init.body)
  assert.equal(pushBody.payload.ops[0].entity, 'todos')
  const readOnly = createBridgeSession({ baseUrl: BASE, credentials: { ...CREDS, scope: 'READ' }, deviceId: 'android-1', fetchImpl: fetch })
  await assert.rejects(() => readOnly.push([{ entity: 'todos', rows: [{ taskId: 't' }] }]), /WRITE scope/)
  await readOnly.pull()
  const expired = createBridgeSession({ baseUrl: BASE, credentials: { ...CREDS, expiresAt: 1 }, deviceId: 'android-1', fetchImpl: fetch, now: () => 2 })
  await assert.rejects(() => expired.pull(), /expired/)
  const limited = fakeFetch(() => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited', retryAfterMs: 900 }) }))
  const limitedSession = createBridgeSession({ baseUrl: BASE, credentials: CREDS, deviceId: 'android-1', fetchImpl: limited })
  await assert.rejects(async () => {
    try { await limitedSession.pull() } catch (e) { assert.equal(e.retryAfterMs, 900); throw e }
  }, /rate_limited/)
})
