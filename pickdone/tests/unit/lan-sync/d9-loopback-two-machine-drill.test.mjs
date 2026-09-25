/**
 * D9 loopback two-machine drill — orchestrator.
 *
 * The 2026-09-18 live drill ran on physical devices; since then waves #131-#140 touched sync
 * code (transport close, conflict backups, oplog constants, sync-apply guards) with only
 * single-node/mocked-DB coverage. A second app instance cannot stand in for a second device
 * (transport port FIXED at 58471) and db.js is a per-process singleton, so this drill runs TWO
 * REAL PROCESSES (the same shape as two machines): each holds a real encrypted SQLite DB and a
 * real TCP node wired through the PRODUCTION merge pipeline. The orchestrator drives
 * create/edit/delete/conflict/restart scenarios over stdio JSONL.
 *
 * Run: node --test tests/unit/lan-sync/d9-loopback-two-machine-drill.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SIDE = path.join(here, 'd9-drill-side.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function launch () {
  const child = spawn(process.execPath, [SIDE], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let buf = ''
  let nextId = 1
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const resolve = pending.get(msg.id)
        if (resolve) { pending.delete(msg.id); resolve(msg) }
      } catch { /* ignore */ }
    }
  })
  const send = msg => new Promise(resolve => {
    const id = 'm' + nextId++
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ id, ...msg }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: 'side timeout' }) } }, 15000)
  })
  const kill = () => { try { child.kill('SIGKILL') } catch {} }
  return { child, send, kill }
}

/** Fresh "machine": its own tmp data dir, its own process. Reusable across restarts via absDir. */
async function startSide (deviceId, absDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-'))) {
  const side = launch()
  const r = await side.send({ do: 'start', dir: absDir, deviceId })
  assert.ok(!r.error, 'side start failed: ' + (r.error || ''))
  const p = await side.send({ do: 'port' })
  assert.ok(!p.error, 'side port failed: ' + (p.error || ''))
  return { ...side, port: p.port, deviceId, absDir }
}

/** Bounded converge loop: rounds on `driver` until `pred` (a getAll read on `reader`) holds. */
async function waitFor (driver, reader, pred, label) {
  const deadline = Date.now() + 12000
  for (;;) {
    for (let i = 0; i < 3; i++) {
      await driver.send({ do: 'round' })
      await sleep(150)
    }
    const r = await reader.send({ do: 'read', op: 'getAll', params: { deleted: null } })
    const rows = r.result || []
    if (pred(rows)) return rows
    if (Date.now() > deadline) throw new Error('drill timeout waiting for: ' + label + ' — rows now: ' + JSON.stringify(rows).slice(0, 600))
  }
}

const write = (side, ops) => side.send({ do: 'write', ops })
const task = (id, content, updateTime, extra = {}) => ({ op: 'upsertMany', params: [{ taskId: id, taskContent: content, categoryId: null, complete: false, delete: false, updateTime, ...extra }] })
const readAll = async side => (await side.send({ do: 'read', op: 'getAll', params: { deleted: null } })).result || []
const pair = (a, b) => {
  a.send({ do: 'addPeer', peer: { deviceId: b.deviceId, host: '127.0.0.1', port: b.port } })
  b.send({ do: 'addPeer', peer: { deviceId: a.deviceId, host: '127.0.0.1', port: a.port } })
}

test('drill: create + bidirectional edit converge between two real sync processes', async () => {
  const A = await startSide('d9-a')
  const B = await startSide('d9-b')
  try {
    pair(A, B)
    await write(A, [task('d9_t1', 'from A', 1000)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'd9_t1' && t.taskContent === 'from A'), 't1 on B')
    await write(B, [task('d9_t1', 'edited on B', 2000)])
    await waitFor(B, A, rows => rows.some(t => t.taskId === 'd9_t1' && t.taskContent === 'edited on B'), 't1 edit back on A')
  } finally { A.kill(); B.kill() }
})

test('drill: delete on A wins on B (tombstone lands, live row gone)', async () => {
  const A = await startSide('d9-c')
  const B = await startSide('d9-d')
  try {
    pair(A, B)
    await write(A, [task('d9_t2', 'to delete', 1000)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'd9_t2'), 't2 on B')
    await write(A, [task('d9_t2', 'to delete', 5000, { delete: true, deletedAt: 5000 })])
    await waitFor(A, B, rows => rows.every(t => t.taskId !== 'd9_t2' || !!t.delete), 't2 deleted on B')
  } finally { A.kill(); B.kill() }
})

test('drill: tomato ledger row converges (row-store entity)', async () => {
  const A = await startSide('d9-e')
  const B = await startSide('d9-f')
  try {
    pair(A, B)
    await write(A, [{ op: 'tomatoAppendMany', params: [{ tomatoId: 'd9_tmt_1', endTime: 1700000000000, dateKey: '2026-09-25', succeed: true, manual: 0 }] }])
    const deadline = Date.now() + 12000
    for (;;) {
      await A.send({ do: 'round' })
      await sleep(200)
      const r = await B.send({ do: 'read', op: 'tomatoAll', params: {} })
      if ((r.result || []).some(x => x.tomatoId === 'd9_tmt_1')) break
      if (Date.now() > deadline) throw new Error('drill timeout waiting for: tomato on B')
    }
  } finally { A.kill(); B.kill() }
})

test('drill: restart both sides — fresh delta converges, no replay duplicates', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-g-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-h-'))
  let A = await startSide('d9-g', dirA)
  let B = await startSide('d9-h', dirB)
  try {
    pair(A, B)
    await write(A, [task('d9_t3', 'pre-restart', 1000)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'd9_t3'), 't3 on B pre-restart')

    // --- restart: fresh processes over the SAME data dirs (cursor/watermarks persist in meta)
    A.kill(); B.kill()
    await sleep(300)
    A = await startSide('d9-g', dirA)
    B = await startSide('d9-h', dirB)
    pair(A, B)

    await write(B, [task('d9_t4', 'post-restart', 6000)])
    await waitFor(B, A, rows => rows.some(t => t.taskId === 'd9_t4' && t.taskContent === 'post-restart'), 't4 on A post-restart')
    const rowsA = await readAll(A)
    assert.equal(rowsA.filter(t => t.taskId === 'd9_t3').length, 1, 'no duplicate rows after restart resume')
  } finally { A.kill(); B.kill() }
})

test('drill: offline edits on both sides — LWW winner identical, loser kept recoverable', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-i-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-j-'))
  const A = await startSide('d9-i', dirA)
  const B = await startSide('d9-j', dirB)
  try {
    pair(A, B)
    await write(A, [task('d9_t5', 'base', 1000)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'd9_t5'), 't5 on B')

    // --- offline: kill both, edit the SAME task with divergent stamps on each side
    A.kill(); B.kill()
    await sleep(300)
    const Aoff = await startSide('d9-i', dirA)
    const Boff = await startSide('d9-j', dirB)
    try {
      await write(Aoff, [task('d9_t5', 'older edit on A', 9000)])
      await write(Boff, [task('d9_t5', 'newer edit on B', 9500)])
    } finally { Aoff.kill(); Boff.kill() }
    await sleep(300)

    // --- reconnect: winner must be identical on both sides; the loser stays recoverable
    const A2 = await startSide('d9-i', dirA)
    const B2 = await startSide('d9-j', dirB)
    try {
      pair(A2, B2)
      await waitFor(A2, A2, rows => rows.some(t => t.taskId === 'd9_t5' && t.taskContent === 'newer edit on B'), 'LWW winner on A')
      await waitFor(B2, B2, rows => rows.every(t => t.taskId !== 'd9_t5' || t.taskContent === 'newer edit on B'), 'LWW winner stays on B')
      const winA = (await readAll(A2)).find(t => t.taskId === 'd9_t5')
      const winB = (await readAll(B2)).find(t => t.taskId === 'd9_t5')
      assert.equal(winA.taskContent, 'newer edit on B')
      assert.equal(winB.taskContent, 'newer edit on B')
      const rowsA2 = await readAll(A2)
      const loserCopy = rowsA2.find(t => !!t.delete && String(t.taskContent || '').includes('older edit on A'))
      assert.ok(loserCopy, 'loser edit preserved as a tombstoned (recycle-bin) copy on A — rows: ' + JSON.stringify(rowsA2).slice(0, 800))
    } finally { A2.kill(); B2.kill() }
  } finally { A.kill(); B.kill() }
})
