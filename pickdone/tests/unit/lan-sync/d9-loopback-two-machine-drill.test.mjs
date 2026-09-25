/**
 * D9 loopback two-machine drill — pair scenarios (create/edit, delete/tombstone, tomato row).
 *
 * The 2026-09-18 live drill ran on physical devices; since then waves #131-#140 touched sync
 * code (transport close, conflict backups, oplog constants, sync-apply guards) with only
 * single-node/mocked-DB coverage. A second app instance cannot stand in for a second device
 * (transport port FIXED at 58471) and db.js is a per-process singleton, so this drill runs TWO
 * REAL PROCESSES (the same shape as two machines): each holds a real encrypted SQLite DB and a
 * real TCP node wired through the PRODUCTION merge pipeline.
 *
 * SPLIT (2026-09-25, local unit-test wall-clock wave): the original single file ran its seven
 * drills serially (~45s wall — the biggest lan-sync hotspot). In-file `concurrency` measured
 * SLOWER on the full suite (file-level workers already saturate the CPU), so the seven tests
 * were split into sibling files that `node --test` runs as separate parallel workers:
 *   - this file: pair create/edit + delete/tombstone + tomato row
 *   - d9-loopback-restart-conflict.test.mjs: restart resume + offline LWW conflict
 *   - d9-loopback-mesh-scale.test.mjs: three-node mesh + 3000-task scale backlog
 *
 * Run: node --test tests/unit/lan-sync/d9-loopback-two-machine-drill.test.mjs
 */
import { test } from 'node:test'
import { startSide, waitFor, write, task, pair } from './d9-drill-helpers.mjs'

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
      await new Promise(r => setTimeout(r, 200))
      const r = await B.send({ do: 'read', op: 'tomatoAll', params: {} })
      if ((r.result || []).some(x => x.tomatoId === 'd9_tmt_1')) break
      if (Date.now() > deadline) throw new Error('drill timeout waiting for: tomato on B')
    }
  } finally { A.kill(); B.kill() }
})
