// LAN sync first-ten-minutes journey suite (node --test).
//
// Encodes the user's REAL first-ten-minutes flow end to end: boot two full app
// instances (the actual electron binary), enable LAN sync on both, pair B with A
// through the app's own two-way-confirmed pairing flow, then exercise the basic
// todo lifecycle across the pair and a hard-kill reconnect. Every assertion runs
// through the instances' CDP endpoints against the production preload surface
// (window.todoAPI.dbCall / window.commands.commit) — no production code is
// stubbed, faked, or required into the test process.
//
// Launcher choice (stated per the ask): this reuses the scripts/dev-duo.mjs
// LAUNCHER PATTERN (real electron.exe, PICKDONE_MULTI=1, TODO_USER_DATA_DIR per
// instance, TODO_SYNC_PORT per instance, CDP port per instance) but drives it
// directly from the test with FRESH temp dirs and FREE sync ports, because the
// journey needs programmatic restart control (J4) and must never touch the fixed
// 58471 port (the user's real instance owns it). Like dev-duo --verify, only the
// pids this suite itself recorded are ever killed.
//
// Scenarios (sequential — each builds on the previous pair):
//   J1 boot pair + two-way pairing completes on both sides.
//   J2 A creates 3 todos (todoTime / reminderTime / plain) -> both converge.
//   J3 B completes, edits, soft-deletes -> A converges; A's recycle bin holds the tombstone.
//   J4 hard-kill B, restart with the same dirs -> pairing survives, changes converge both ways.
//
// Run: node --test tests/integration/lan-sync-journey.test.mjs
//
// Like tests/integration/lan-sync-loopback.test.mjs, this spawns live processes
// and is excluded from the run-all default pool; it is a dedicated gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Harness (trace/until/freePort/Cdp/Instance) moved VERBATIM to tests/lib/lan-sync-pair.mjs (2026-11-05, shared with the pd20 episode journey)
import { trace, until, freePort, spawnAvailable, Instance, makePairDirs } from '../lib/lan-sync-pair.mjs'

const { root: scratchRoot, dirA, dirB } = makePairDirs()


// Journey runtime bound. Every await in this file is individually timeout-bounded; this is
// the last-resort watchdog so a wedged CDP socket or child-runner glitch can never hang the
// gate past the budget. Prefer a loud failure over a silent hang.
// Budget arithmetic (2026-10-09): worst case is roughly J1's two 60s boot budgets + ~150s
// of bounded pairing waits, plus J4's restart — whose connectCdp now gets a FRESH 60s boot
// budget per lock-loss relaunch (deadline renewal fix) — then 120s pairing-intact + 60s
// convergence. The old 175s ceiling could be outrun by exactly the legit relaunch path
// this suite is designed to survive, so it is raised to 300s to cover the sum.
// 600s (was 300s, 2026-10-23 evening): the real journeys each run ~60-90s under a
// LOADED host (boot probes and convergence polls scale with ambient load), so the full
// gate blew the 300s ceiling mid-J4 and the force-exit red'd the FILE with J1-J3 already
// green - the budget-doesn't-cover-worst-path law again. Still a hard bound: a wedged run
// dies named instead of hanging the tier.
// 900s (same evening, after 600s also fired in-gate): IN-GATE (three pools racing) the
// suite measured ~2-3x its solo wall, so 600s left no margin against a burst multiplier.
// 900s covers ~3x the solo worst path while staying a hard named bound inside the 20min
// stage budget. Note: run-all children carry --test-force-exit, so the post-suite handle
// leak this watchdog also bounds only bites bare `node --test` invocations.
const WATCHDOG_MS = 900_000
const watchdog = setTimeout(() => {
  console.error(`[lan-sync-journey] GLOBAL WATCHDOG (${WATCHDOG_MS}ms) fired — force-exiting (1)`)
  if (process.env.JOURNEY_DIAG && process.report) {
    try {
      const rep = process.report.getReport()
      console.error('[lan-sync-journey] JS stack at watchdog:\n' + JSON.stringify(rep.javascriptStack, null, 2))
    } catch (e) { console.error('[lan-sync-journey] report failed: ' + e.message) }
  }
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()
const liveInstances = new Set()

test.after(async () => {
  // each-catch: one stuck instance must never stop the reap of the others
  for (const inst of liveInstances) { try { await inst.stop() } catch { /* keep reaping */ } }
  // Final orphan sweep: a main process that died MID-run leaves children whose parent link
  // is already dead — taskkill /T (and the stop() above) cannot see them. Kill every
  // electron whose command line anchors at THIS worktree and whose parent is gone.
  // Path-scoped on purpose: never touch electrons outside the worktree by name alone.
  try {
    const { execSync } = await import('node:child_process')
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -match 'journey-audit' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', timeout: 60000 })
  } catch { /* best effort */ }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }) } catch { /* locked files left to the OS */ }
})

/** Poll until BOTH instances agree on the expected live todo state. Conflict-copy
 *  recycle-bin rows (merge.mjs conflictCopy, taskId '-conflict-<suffix>') are machine
 *  bookkeeping and may legitimately appear on either side — they are ignored here; the
 *  caller asserts the deleted rows' tombstones via binTodos() separately. */
async function expectConverged (a, b, wantIds, rowCheck, ms = 30000) {
  const want = new Set(wantIds)
  let lastSnap = ''
  let lastBad = ''
  const res = await until(async () => {
    const ta = (await a.liveTodos()).filter(r => !String(r.taskId).includes('-conflict-'))
    const tb = (await b.liveTodos()).filter(r => !String(r.taskId).includes('-conflict-'))
    lastSnap = `A=[${ta.map(r => r.taskId + (r.delete ? '(bin)' : '') + (r.complete ? '(done)' : '')).join(',')}] ` +
      `B=[${tb.map(r => r.taskId + (r.delete ? '(bin)' : '') + (r.complete ? '(done)' : '')).join(',')}]`
    const idsA = new Set(ta.map(t => t.taskId))
    const idsB = new Set(tb.map(t => t.taskId))
    let ok = true
    for (const id of want) { if (!idsA.has(id) || !idsB.has(id)) ok = false }
    for (const id of idsA) { if (!want.has(id)) ok = false }
    for (const id of idsB) { if (!want.has(id)) ok = false }
    if (ok && rowCheck) {
      for (const t of [...ta, ...tb]) { const bad = rowCheck(t); if (bad) { lastBad = t.taskId + ': ' + bad; ok = false } }
    }
    if (ok) return { a: ta, b: tb }
    return null
  }, ms, 'both instances converge').catch(async (e) => {
    let peerInfo = ''
    try {
      const [sa, sb] = await Promise.all([a.status(), b.status()])
      const fmt = (s) => JSON.stringify({ self: s.self && s.self.deviceId, port: s.port,
        peers: (s.peers || []).map(p => ({ id: p.deviceId && p.deviceId.slice(0, 8), st: p.peerState, online: p.online, err: p.lastError, wm: p.watermark })),
        lastError: s.lastError })
      peerInfo = ' — A peers: ' + fmt(sa) + ' — B peers: ' + fmt(sb)
    } catch (err) { peerInfo = ' — status read failed: ' + err.message }
    throw new Error('timed out (' + ms + 'ms): both instances converge on [' + [...want].join(',') + ']' +
      (rowCheck ? ' with row checks passing' : '') + ' — last snapshot: ' + lastSnap +
      (lastBad ? ' — rowCheck: ' + lastBad : '') + peerInfo)
  })
  return res
}

// A single journey pair, driven through the four sequential scenarios. All four
// tests are skipped wholesale when spawning is unavailable (sandbox without the
// electron binary or without child spawn / WebSocket).
const pair = { a: null, b: null, ready: false }

test('J1: boot pair + enable sync + two-way pairing completes on both sides', async (t) => {
  if (!spawnAvailable) {
    return t.skip('electron binary or WebSocket/spawn unavailable in this sandbox — journey scenarios skipped')
  }
  try {
    const [cdpA, cdpB, syncA, syncB] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const a = new Instance({ name: 'A', cdpPort: cdpA, syncPort: syncA, userDir: dirA })
    const b = new Instance({ name: 'B', cdpPort: cdpB, syncPort: syncB, userDir: dirB })
    liveInstances.add(a); liveInstances.add(b)
    pair.a = a; pair.b = b
    await a.boot()
    await b.boot()

    // Enable sync on both. NOTE (found by this suite, first run): the sync.* ops are
    // async in db.OPS, and commands:commit pushes their pending Promise into its
    // {results:[...]} envelope, which cannot be structured-cloned over IPC. The
    // renderer's own command bus therefore aliases sync.* commands to the dbCall door
    // (renderer/js/utils/commandBus.js 'sync.setEnabled': 'syncSetEnabled') — this
    // suite uses that same production alias path for every sync.* op.
    await a.dbCall('syncSetEnabled', { enabled: true })
    await b.dbCall('syncSetEnabled', { enabled: true })
    const stA = await until(async () => {
      const s = await a.status()
      return s.listening ? s : null
    }, 15000, '[A] sync node listening after enable')
    const stB = await until(async () => {
      const s = await b.status()
      return s.listening ? s : null
    }, 15000, '[B] sync node listening after enable')
    assert.equal(stA.port, syncA, '[A] binds the per-instance TODO_SYNC_PORT')
    assert.equal(stB.port, syncB, '[B] binds the per-instance TODO_SYNC_PORT')
    assert.ok(stA.port !== 58471 && stB.port !== 58471, 'neither instance may squat the user’s real sync port 58471')

    // Two-way pairing, exactly the app's flow: B requests at 127.0.0.1:<A port>,
    // A's human accepts via syncPairRespond on the surfaced pendingPair.
    const requestPromise = b.dbCall('syncPairRequest', { host: '127.0.0.1', port: stA.port }, 45000)
    await until(async () => {
      const s = await a.status()
      return !!(s.pendingPair && s.pendingPair.deviceId)
    }, 20000, '[A] pendingPair surfaced for the inbound pair request')
    const responded = await a.dbCall('syncPairRespond', { accept: true })
    assert.equal(responded && responded.ok, true, '[A] pair respond accepted')

    const reqResult = await requestPromise
    assert.ok(reqResult && (reqResult.peer || reqResult.deviceId),
      '[B] pair request resolves with the accepted peer: ' + JSON.stringify(reqResult).slice(0, 200))

    // Pairing completes on BOTH sides: each status shows the other as a paired peer,
    // healthy after the first round.
    await until(async () => {
      const sa = await a.status()
      const sb = await b.status()
      return (sa.peers || []).some(p => p.deviceId === sb.self.deviceId) &&
             (sb.peers || []).some(p => p.deviceId === sa.self.deviceId)
    }, 30000, 'both instances list each other as paired peers')
    // Peer state 'ok' after the first round. Race guard: pairing restarts BOTH nodes
    // (pair-ops syncPairRequest: stopSync -> startSync -> runRound); if one side's
    // post-pair round dials while the other is still rebinding its port, the peer parks
    // in 'error' with no auto-retry. Kick it the way the app itself does (syncSetName
    // restarts the node; startSync's timer fires a fresh round 2s later) every 6s
    // while the state has not settled yet.
    let lastKickAt = 0
    await until(async () => {
      const sa = await a.status()
      const sb = await b.status()
      const pa = (sa.peers || []).find(p => p.deviceId === sb.self.deviceId)
      const pb = (sb.peers || []).find(p => p.deviceId === sa.self.deviceId)
      if (pa && pb && pa.peerState === 'ok' && pb.peerState === 'ok') return true
      if (Date.now() - lastKickAt > 6000) {
        lastKickAt = Date.now()
        await a.dbCall('syncSetName', { name: 'Journey-A' }).catch(() => {})
        await b.dbCall('syncSetName', { name: 'Journey-B' }).catch(() => {})
      }
      return null
    }, 40000, 'peer state is ok on both sides after the first round')

    trace('J1 complete: pair is up and paired both ways')
    pair.ready = true
  } catch (e) {
    // [signal-integrity 2026-10-25] EADDRINUSE under a full gate is usually OUR OWN
    // concurrency contention (the run pools + sibling gates fighting for ports) — that is
    // a load signal, not a missing sandbox capability; skipping it cascades J2-J4 into
    // silent greens. Only a true no-spawn sandbox (ENOENT on the electron binary / the
    // runner's spawn surface) is a legitimate skip; everything else stays a red.
    if (/ENOENT/i.test(String(e.message))) {
      return t.skip('process spawning unavailable in this sandbox: ' + e.message)
    }
    throw e
  }
})

test('J2: first sync — A creates 3 todos (todoTime / reminderTime / plain), both sides converge', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair
  const t0 = Date.now()
  await a.commit('todo', 'put', { taskId: 'journey-time-1', taskContent: 'has todoTime', todoTime: t0 })
  await a.commit('todo', 'put', { taskId: 'journey-rem-1', taskContent: 'has reminder', reminderTime: t0 + 3600_000 })
  await a.commit('todo', 'put', { taskId: 'journey-plain-1', taskContent: 'plain todo' })

  const { a: ta, b: tb } = await expectConverged(a, b,
    ['journey-time-1', 'journey-rem-1', 'journey-plain-1'],
    (row) => {
      if (row.taskId === 'journey-time-1' && Number(row.todoTime) !== t0) return 'todoTime lost'
      if (row.taskId === 'journey-rem-1' && Number(row.reminderTime) !== t0 + 3600_000) return 'reminderTime lost'
      if (row.taskId === 'journey-plain-1' && (row.todoTime || row.reminderTime)) return 'plain row grew schedule fields'
      return null
    })

  // Assert on BOTH instances (per the ask): each side's copy of every field.
  for (const [name, rows] of [['A', ta], ['B', tb]]) {
    const byId = new Map(rows.map(r => [r.taskId, r]))
    assert.equal(byId.get('journey-time-1').taskContent, 'has todoTime', `[${name}] todoTime row content`)
    assert.equal(Number(byId.get('journey-time-1').todoTime), t0, `[${name}] todoTime round-trips`)
    assert.equal(Number(byId.get('journey-rem-1').reminderTime), t0 + 3600_000, `[${name}] reminderTime round-trips`)
    assert.equal(byId.get('journey-plain-1').taskContent, 'plain todo', `[${name}] plain row content`)
    assert.ok(!byId.get('journey-plain-1').delete, `[${name}] plain row live`)
  }
})

test('J3: bidirectional basic ops — B completes/edits/deletes, A converges, recycle bin holds the tombstone', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair
  trace('J3: start')

  // B completes one, edits one (title change), soft-deletes one — all through the
  // production command path. NOTE: todo.put is a full-row UPSERT (db.js upsert /
  // todoToRow) — a partial payload would clobber unspecified fields with defaults —
  // so each op carries the FULL current row the way the renderer does, MINUS the stale
  // LWW stamp: a carried-over updateTime ties with the peer's copy and merge.mjs
  // resolves the tie against the delete/edit ("same-stamp echo — local row stands").
  const fresh = (row, patch) => {
    const p = { ...row, ...patch }
    delete p.updateTime
    delete p.createTime
    delete p.syncTime
    return p
  }
  await b.commit('todo', 'put', fresh((await b.liveTodos()).find(r => r.taskId === 'journey-plain-1'), { complete: true }))
  trace('J3: completion committed on B')
  const rowOnB = (await b.liveTodos()).find(r => r.taskId === 'journey-time-1')
  assert.ok(rowOnB, 'B holds the todoTime row before editing it')
  await b.commit('todo', 'put', fresh(rowOnB, { taskContent: 'edited by B' }))
  trace('J3: title edit committed on B')
  // The tombstone's LWW age is its deletedAt (db-rows.js todoToRow: a deleted row's honest
  // age is deletedAt, not updateTime) — carried-over deletedAt=0 makes the tombstone
  // epoch-oldest and the live row resurrects it on the next round.
  await b.commit('todo', 'put', fresh((await b.liveTodos()).find(r => r.taskId === 'journey-rem-1'), { delete: true, deletedAt: Date.now() }))
  trace('J3: soft delete committed on B, polling convergence')

  const { a: ta, b: tb } = await expectConverged(a, b,
    ['journey-time-1', 'journey-plain-1'],
    (row) => {
      if (row.taskId === 'journey-plain-1' && !row.complete) return 'completion not applied'
      if (row.taskId === 'journey-time-1' && row.taskContent !== 'edited by B') return 'title edit not applied'
      return null
    })

  for (const [name, rows] of [['A', ta], ['B', tb]]) {
    const byId = new Map(rows.map(r => [r.taskId, r]))
    assert.equal(byId.get('journey-plain-1').complete, true, `[${name}] completion synced`)
    assert.equal(byId.get('journey-time-1').taskContent, 'edited by B', `[${name}] title edit synced`)
    assert.ok(!byId.has('journey-rem-1'), `[${name}] deleted row left the live set`)
  }
  // Recycle bin on A holds the tombstoned row (soft delete, not a hard delete).
  const binA = await until(async () => {
    const bin = await a.binTodos()
    return bin.some(r => r.taskId === 'journey-rem-1') ? bin : null
  }, 30000, '[A] recycle bin holds the tombstoned row')
  const tomb = binA.find(r => r.taskId === 'journey-rem-1')
  assert.equal(tomb.delete, true, '[A] recycle-bin row carries the delete flag')
  assert.ok(Number(tomb.deletedAt) > 0, '[A] recycle-bin row carries a deletion timestamp')
  // Symmetry check on B's bin too.
  const binB = await b.binTodos()
  assert.ok(binB.some(r => r.taskId === 'journey-rem-1'), '[B] recycle bin also holds the tombstone')
})

test('J4: reconnect — hard-kill B, restart with the same dirs, pair state survives, changes converge both ways', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair

  // Hard kill (ungraceful unplug — same semantics as the user yanking the app),
  // then restart on the SAME data dir / sync port (dev-duo --keep semantics). The
  // CDP port is re-allocated: after a hard kill the old port may linger in TIME_WAIT.
  const aSelf = (await a.status()).self
  const bCdpPort = await freePort()
  const bSyncPort = b.syncPort
  trace('J4: hard-killing B (pid ' + b.pid + ')')
  await b.killHard()
  // [J4 2026-10-24] Wait out the dead predecessor's file handles before B2 boots: a boot
  // that opens the fresh db mid-release fails init ("file held by another process") and the
  // app degrades into the db-less shell — sync status reads factory-fresh and the pairing
  // wait below burns out red. Mirror of the db.js open-retry fix, at test pacing level.
  // Three files: the WAL/SHM siblings ride the same handle set as the main db.
  await until(() => {
    const probe = ['todos.db', 'todos.db-wal', 'todos.db-shm']
      .map(f => path.join(dirB, f))
      .filter(f => fs.existsSync(f))
      .every(f => { try { const fd = fs.openSync(f, 'r+'); fs.closeSync(fd); return true } catch { return false } })
    return probe || null
  }, 30000, 'todos.db set still held after the hard kill (predecessor handles never released)')
  trace('J4: B dead, restarting on the same data dir + sync port')

  const b2 = new Instance({ name: 'B2', cdpPort: bCdpPort, syncPort: bSyncPort, userDir: dirB })
  liveInstances.add(b2)
  pair.b = b2
  await b2.boot()
  trace('J4: B2 CDP up')

  // Pair state survived the crash: sync is still enabled and B still holds A as a
  // paired peer (persisted sync.peers restored on boot).
  let stB2 = null
  try {
    stB2 = await until(async () => {
      const s = await b2.status()
      return s.enabled && (s.peers || []).some(p => p.deviceId === aSelf.deviceId) ? s : null
    }, 120000, '[B2] restarted with pairing intact (enabled + A in the peer table)')
  } catch (e) {
    // One-shot diagnostic: dump B2's actual status at the failure instant so the
    // next move is evidence (budget vs real pairing loss), not attribution.
    try { console.error('[J4][diag] B2 status at failure: ' + JSON.stringify(await b2.status())) } catch (e2) { console.error('[J4][diag] B2 status unreadable: ' + e2.message) }
    try { console.error('[J4][diag] A status at failure: ' + JSON.stringify(await a.status())) } catch (e2) { console.error('[J4][diag] A status unreadable: ' + e2.message) }
    throw e
  }
  assert.ok(stB2.listening, '[B2] sync node listening again after restart')

  // Pending changes converge BOTH ways: A pushes an edit, restarted B pushes a new row.
  // Same full-row-minus-stamp rule as J3 for A's post-restart edit.
  const aRow = (await a.liveTodos()).find(r => r.taskId === 'journey-time-1')
  const editPayload = { ...aRow, taskContent: 'post-restart edit from A' }
  delete editPayload.updateTime
  delete editPayload.createTime
  delete editPayload.syncTime
  await a.commit('todo', 'put', editPayload)
  await b2.commit('todo', 'put', { taskId: 'journey-post-restart', taskContent: 'written on restarted B' })
  trace('J4: post-restart writes committed on both sides, polling convergence')

  const { a: ta, b: tb } = await expectConverged(a, b2,
    ['journey-time-1', 'journey-plain-1', 'journey-post-restart'],
    (row) => (row.taskId === 'journey-time-1' && row.taskContent !== 'post-restart edit from A')
      ? 'A post-restart edit not applied'
      : null, 150000)

  const byA = new Map(ta.map(r => [r.taskId, r]))
  const byB = new Map(tb.map(r => [r.taskId, r]))
  assert.equal(byA.get('journey-plain-1').taskContent, 'plain todo',
    '[A] completion kept the full row content (full-row upsert)')
  assert.equal(byA.get('journey-post-restart').taskContent, 'written on restarted B',
    '[A] received the restarted B’s row (B -> A direction)')
  assert.equal(byB.get('journey-time-1').taskContent, 'post-restart edit from A',
    '[B] received A’s post-restart edit (A -> B direction)')
  assert.equal(byB.get('journey-plain-1').complete, true,
    '[B] pre-crash completion state still intact after reconnect')
})
