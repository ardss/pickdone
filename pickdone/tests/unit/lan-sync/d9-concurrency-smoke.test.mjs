/**
 * Regression guard for D9 drill parallelism (2026-09-25): the seven drill scenarios now live in
 * SIBLING files (d9-loopback-two-machine-drill / -restart-conflict / -mesh-scale) so `node --test`
 * runs them as separate parallel workers — plus the short-lived in-file `concurrency` experiment.
 * All of that is safe only while this invariant holds: N sides started SIMULTANEOUSLY must all
 * bind DISTINCT ephemeral TCP ports on DISTINCT mkdtemp data dirs, and two independent pairs must
 * each complete a write->converge round-trip while the others are live — no port collision, no
 * dir cross-talk.
 *
 * Run: node --test tests/unit/lan-sync/d9-concurrency-smoke.test.mjs
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

test('smoke: 4 concurrent drill sides — distinct ports, distinct dirs, two independent pairs converge', async () => {
  // Four sides launch in the SAME tick: whichever collision the concurrent drill could hit
  // (port reuse, shared tmp dir) would reproduce here.
  const dirs = Array.from({ length: 4 }, () => fs.mkdtempSync(path.join(os.tmpdir(), 'd9smoke-')))
  const sides = await Promise.all([
    'smoke-a', 'smoke-b', 'smoke-c', 'smoke-d',
  ].map(async (deviceId, i) => {
    const side = launch()
    const r = await side.send({ do: 'start', dir: dirs[i], deviceId })
    assert.ok(!r.error, 'side start failed: ' + (r.error || ''))
    const p = await side.send({ do: 'port' })
    assert.ok(!p.error, 'side port failed: ' + (p.error || ''))
    return { ...side, port: p.port, dir: r.dir, deviceId }
  }))
  try {
    // no port collision: four live TCP nodes, four distinct ephemeral ports
    assert.equal(new Set(sides.map(s => s.port)).size, 4, 'ports must be distinct: ' + sides.map(s => s.port))
    // no dir cross-talk: each side reports the dir it was handed (side echoes it on start)
    assert.equal(new Set(sides.map(s => s.dir)).size, 4, 'data dirs must be distinct')
    for (let i = 0; i < 4; i++) assert.ok(sides[i].dir.startsWith(dirs[i]), `side ${i} must own its own mkdtemp dir`)

    // two INDEPENDENT pairs sync concurrently — pair 1 (a,b) and pair 2 (c,d) interleave rounds
    const pairUp = (x, y) => {
      x.send({ do: 'addPeer', peer: { deviceId: y.deviceId, host: '127.0.0.1', port: y.port } })
      y.send({ do: 'addPeer', peer: { deviceId: x.deviceId, host: '127.0.0.1', port: x.port } })
    }
    pairUp(sides[0], sides[1])
    pairUp(sides[2], sides[3])
    const task = (id, content) => ({ op: 'upsertMany', params: [{ taskId: id, taskContent: content, categoryId: null, complete: false, delete: false, updateTime: 1000 }] })
    await sides[0].send({ do: 'write', ops: [task('smoke_p1', 'pair one')] })
    await sides[2].send({ do: 'write', ops: [task('smoke_p2', 'pair two')] })

    const converge = async (driver, reader, taskId, label) => {
      const deadline = Date.now() + 12000
      for (;;) {
        for (let i = 0; i < 3; i++) {
          await driver.send({ do: 'round' })
          await sleep(120)
        }
        const r = await reader.send({ do: 'read', op: 'getAll', params: { deleted: null } })
        if ((r.result || []).some(t => t.taskId === taskId)) return
        if (Date.now() > deadline) throw new Error('smoke timeout: ' + label)
      }
    }
    await Promise.all([
      converge(sides[0], sides[1], 'smoke_p1', 'p1 row on b'),
      converge(sides[2], sides[3], 'smoke_p2', 'p2 row on d'),
    ])
  } finally { for (const s of sides) s.kill() }
})
