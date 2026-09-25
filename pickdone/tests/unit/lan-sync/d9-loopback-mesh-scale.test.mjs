/**
 * D9 loopback drill — three-node mesh + 3000-task scale backlog (split from the orchestrator
 * file, 2026-09-25 wall-clock wave — see d9-loopback-two-machine-drill.test.mjs header for
 * why the seven drills became three sibling files).
 *
 * Run: node --test tests/unit/lan-sync/d9-loopback-mesh-scale.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startSide, waitFor, write, task, pair, sleep } from './d9-drill-helpers.mjs'

test('drill: three-node mesh — a write on any node converges to BOTH peers (2026-09-25 gap: only pairs were tested)', async () => {
  const A = await startSide('d9-m1')
  const B = await startSide('d9-m2')
  const C = await startSide('d9-m3')
  try {
    pair(A, B); pair(A, C)
    // Production topology note: B and C reach each other ONLY through A (star/hub). Relay rides
    // the periodic rounds every node runs (bootstrap ROUND_INTERVAL_MS), so the converge loop
    // drives rounds on ALL sides — exactly what the 5-minute timer does in a real deployment.
    const roundAll = async () => { for (const s of [A, B, C]) { try { await s.send({ do: 'round' }) } catch { /* next tick */ } } }
    const waitForMesh = async (reader, pred, label) => {
      const deadline = Date.now() + 15000
      for (;;) {
        await roundAll()
        await sleep(150)
        const r = await reader.send({ do: 'read', op: 'getAll', params: { deleted: null } })
        if (pred(r.result || [])) return
        if (Date.now() > deadline) throw new Error('drill timeout waiting for: ' + label)
      }
    }
    await write(A, [task('d9_m1_row', 'from m1', 1000)])
    await waitForMesh(B, rows => rows.some(t => t.taskId === 'd9_m1_row'), 'm1 row on B')
    await waitForMesh(C, rows => rows.some(t => t.taskId === 'd9_m1_row'), 'm1 row on C')
    await write(B, [task('d9_m2_row', 'from m2', 2000)])
    await waitForMesh(A, rows => rows.some(t => t.taskId === 'd9_m2_row'), 'm2 row on A')
    await waitForMesh(C, rows => rows.some(t => t.taskId === 'd9_m2_row'), 'm2 row on C')
    await write(C, [task('d9_m3_row', 'from m3', 3000)])
    await waitForMesh(A, rows => rows.some(t => t.taskId === 'd9_m3_row'), 'm3 row on A')
    await waitForMesh(B, rows => rows.some(t => t.taskId === 'd9_m3_row'), 'm3 row on B')
  } finally { A.kill(); B.kill(); C.kill() }
})

test('drill: scale — 3000-task initial sync converges within the gate budget (2026-09-25 gap: backlog size never tested end-to-end)', async () => {
  const A = await startSide('d9-s1')
  const B = await startSide('d9-s2')
  try {
    const N = 3000
    // batch writes: 60 x 50-row upsertMany calls (each call = N oplog rows, segments pack at 256KB)
    for (let b = 0; b < N / 50; b++) {
      await write(A, [{ op: 'upsertMany', params: Array.from({ length: 50 }, (_, i) => ({
        taskId: `d9_scale_${b * 50 + i}`, taskContent: `scale row ${b * 50 + i} pad:${'x'.repeat(80)}`, categoryId: null, complete: false, delete: false, updateTime: b * 50 + i,
      })) }])
    }
    pair(A, B)
    await waitFor(A, B, rows => rows.filter(t => String(t.taskId).startsWith('d9_scale_')).length === N, `all ${N} scale rows on B`)
    const r = await B.send({ do: 'read', op: 'getAll', params: { deleted: null } })
    assert.equal((r.result || []).filter(t => String(t.taskId).startsWith('d9_scale_')).length, N)
  } finally { A.kill(); B.kill() }
})
