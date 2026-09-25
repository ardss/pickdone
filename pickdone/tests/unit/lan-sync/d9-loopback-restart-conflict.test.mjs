/**
 * D9 loopback drill — restart resume + offline LWW conflict (split from the orchestrator
 * file, 2026-09-25 wall-clock wave — see d9-loopback-two-machine-drill.test.mjs header for
 * why the seven drills became three sibling files).
 *
 * Run: node --test tests/unit/lan-sync/d9-loopback-restart-conflict.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSide, waitFor, write, task, readAll, pair, sleep } from './d9-drill-helpers.mjs'

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
