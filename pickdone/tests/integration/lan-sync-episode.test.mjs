// PD20 (2026-11-05) P0-3b — cross-device WORK HANDOFF journey: two REAL app instances
// (actual electron binary, isolated userData dirs, dedicated sync ports) pair through the
// app's own flow, then the work-handoff rows (work_episodes / source_refs /
// task_source_links) sync across the pair and the machine-local safety boundary holds.
//
// Scenarios (sequential — one shared pair):
//   W1 boot pair + two-way pairing (same production flow as the todo journey).
//   W2 A records an episode + a portable web source on a REAL task -> both converge
//      (B's queryEpisodesByTask / querySourcesByTask see them — the takeover read).
//   W3 the machine-local gate: a `file`-provider source ref on A NEVER reaches B,
//      while the portable ref does (same task, same round).
//   W4 B (the takeover device) appends its own episode -> A converges (bidirectional).
//   W5 A deletes the episode -> the tombstone lands on B (delete-wins propagation).
//
// Run: node --test tests/integration/lan-sync-episode.test.mjs
// Harness: tests/lib/lan-sync-pair.mjs (verbatim-shared with the todo journey).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sleep, trace, until, freePort, spawnAvailable, Instance } from '../lib/lan-sync-pair.mjs'

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sync-episode-'))
const dirA = path.join(scratchRoot, 'instance-a')
const dirB = path.join(scratchRoot, 'instance-b')
const liveInstances = new Set()

test.after(async () => {
  for (const inst of liveInstances) { try { await inst.stop() } catch { /* keep reaping */ } }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }) } catch { /* locked files left to the OS */ }
})

// Read the handoff state through the SAME production read ops the EditPanel uses.
const episodesOf = (inst, taskId) => inst.dbCall('queryEpisodesByTask', taskId)
const sourcesOf = (inst, taskId) => inst.dbCall('querySourcesByTask', taskId)

const pair = { a: null, b: null, ready: false }
const TASK_ID = 'pd20-epsync-task-1'

test('W1: boot pair + enable sync + two-way pairing', async (t) => {
  if (!spawnAvailable) return t.skip('electron binary or WebSocket/spawn unavailable')
  try {
    const [cdpA, cdpB, syncA, syncB] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const a = new Instance({ name: 'EA', cdpPort: cdpA, syncPort: syncA, userDir: dirA })
    const b = new Instance({ name: 'EB', cdpPort: cdpB, syncPort: syncB, userDir: dirB })
    liveInstances.add(a); liveInstances.add(b)
    pair.a = a; pair.b = b
    await a.boot()
    await b.boot()
    await a.dbCall('syncSetEnabled', { enabled: true })
    await b.dbCall('syncSetEnabled', { enabled: true })
    const [stA, stB] = await Promise.all([
      until(async () => { const s = await a.status(); return s.listening ? s : null }, 15000, '[EA] listening'),
      until(async () => { const s = await b.status(); return s.listening ? s : null }, 15000, '[EB] listening'),
    ])
    assert.ok(stA.port !== 58471 && stB.port !== 58471, 'never squat the user sync port')
    const requestPromise = b.dbCall('syncPairRequest', { host: '127.0.0.1', port: stA.port }, 45000)
    await until(async () => { const s = await a.status(); return !!(s.pendingPair && s.pendingPair.deviceId) }, 20000, '[EA] pendingPair')
    const responded = await a.dbCall('syncPairRespond', { accept: true })
    assert.equal(responded && responded.ok, true, '[EA] pair accepted')
    const reqResult = await requestPromise
    assert.ok(reqResult && (reqResult.peer || reqResult.deviceId), '[EB] paired')
    let lastKickAt = 0
    await until(async () => {
      const sa = await a.status()
      const sb = await b.status()
      const pa = (sa.peers || []).find(p => p.deviceId === sb.self.deviceId)
      const pb = (sb.peers || []).find(p => p.deviceId === sa.self.deviceId)
      if (pa && pb && pa.peerState === 'ok' && pb.peerState === 'ok') return true
      if (Date.now() - lastKickAt > 6000) {
        lastKickAt = Date.now()
        await a.dbCall('syncSetName', { name: 'EpJourney-A' }).catch(() => {})
        await b.dbCall('syncSetName', { name: 'EpJourney-B' }).catch(() => {})
      }
      return null
    }, 40000, 'peer state ok both sides')
    pair.ready = true
    trace('W1 complete')
  } catch (e) {
    if (/ENOENT/i.test(String(e.message))) return t.skip('spawning unavailable: ' + e.message)
    throw e
  }
})

test('W2: A records episode + portable source -> both instances converge (takeover read works on B)', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted')
  const { a, b } = pair
  await a.commit('todo', 'put', { taskId: TASK_ID, taskContent: 'PD20 cross-device handoff task' })
  const putEp = await a.commit('episode', 'put', {
    taskId: TASK_ID, startedAt: Date.now() - 5000, endedAt: Date.now(),
    note: 'goal: investigate handoff sync\noutcome: found the missing sync entities\nnextAction: verify on the peer',
  })
  assert.ok(putEp, 'A episode.put returned an id')
  const putSrc = await a.commit('source', 'put', { providerId: 'github', externalId: 'https://github.com/ardss/pickdone/issues/195', title: 'issue 195' })
  await a.commit('tasksource', 'put', { taskId: TASK_ID, sourceRefId: putSrc })

  // Both sides converge: B's takeover read sees the episode and the source (production
  // read ops, same ones the EditPanel and the CLI work context use).
  await until(async () => {
    const [ea, eb] = await Promise.all([episodesOf(a, TASK_ID), episodesOf(b, TASK_ID)])
    return ea.length === 1 && eb.length === 1 &&
      eb[0].episodeId === ea[0].episodeId &&
      String(eb[0].summary || '').includes('found the missing sync entities')
  }, 45000, 'episode converges to B with content intact')
  await until(async () => {
    const [sa, sb] = await Promise.all([sourcesOf(a, TASK_ID), sourcesOf(b, TASK_ID)])
    return sa.length === 1 && sb.length === 1 && sb[0].canonicalUri === sa[0].canonicalUri
  }, 45000, 'portable source ref converges to B')
  trace('W2 complete')
})

test('W3: machine-local gate — a file-provider source ref NEVER reaches B', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted')
  const { a, b } = pair
  const fileSrc = await a.commit('source', 'put', { providerId: 'file', externalId: 'K:/pd20-e2e/spec-notes.md', title: 'local spec' })
  await a.commit('tasksource', 'put', { taskId: TASK_ID, sourceRefId: fileSrc })
  // A sees both sources; B converged on the LINK but not the file-backed ref (its JOIN hides
  // the missing ref — no dangling entry, no absolute-path leak).
  await until(async () => {
    const sa = await sourcesOf(a, TASK_ID)
    if (sa.length !== 2) trace('[W3 diag] A sources: ' + JSON.stringify(sa))
    return sa.length === 2 && sa.some(s => s.canonicalUri === 'file://K:/pd20-e2e/spec-notes.md')
  }, 30000, 'A sees both sources (portable + file)')
  await sleep(12000) // let at least one sync round pass beyond the writes
  const sb = await sourcesOf(b, TASK_ID)
  assert.equal(sb.length, 1, `B still holds exactly ONE source (the portable ref), got: ${JSON.stringify(sb)}`)
  assert.equal(sb[0].canonicalUri, 'github://https://github.com/ardss/pickdone/issues/195', 'B has the portable ref (canonicalUri = providerId://externalId per the db-episode-ops composer), not the file path')
  assert.ok(!JSON.stringify(sb).includes('K:/pd20-e2e'), 'the local absolute path never egressed to B')
  trace('W3 complete')
})

test('W4: B (takeover device) appends its own episode -> A converges', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted')
  const { a, b } = pair
  await b.commit('episode', 'put', {
    taskId: TASK_ID, startedAt: Date.now(), note: 'goal: continue the takeover\noutcome: peer verified the fix\nnextAction: ship it',
  })
  await until(async () => {
    const [ea, eb] = await Promise.all([episodesOf(a, TASK_ID), episodesOf(b, TASK_ID)])
    return ea.length === 2 && eb.length === 2 &&
      ea.some(e => String(e.summary || '').includes('continue the takeover'))
  }, 45000, 'B-added episode converges back to A')
  trace('W4 complete')
})

test('W5: A deletes an episode -> the tombstone lands on B (delete-wins)', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted')
  const { a, b } = pair
  const ea = await episodesOf(a, TASK_ID)
  trace('[W5 diag] A episodes before delete: ' + JSON.stringify(ea))
  const victim = ea.find(e => String(e.summary || '').includes('investigate handoff sync'))
  assert.ok(victim, 'the episode to delete exists on A')
  const changed = await a.commit('episode', 'removeIds', [victim.episodeId])
  assert.ok(Array.isArray(changed) && changed.includes(victim.episodeId), 'removeIds reports the changed id')
  await until(async () => {
    const [ra, rb] = await Promise.all([episodesOf(a, TASK_ID), episodesOf(b, TASK_ID)])
    return ra.length === 1 && rb.length === 1 &&
      !String(rb[0].summary || '').includes('investigate handoff sync')
  }, 45000, 'the deletion propagates to B (B keeps only the takeover episode)')
  trace('W5 complete')
})
