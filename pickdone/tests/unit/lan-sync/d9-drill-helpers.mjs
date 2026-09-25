/**
 * Shared helpers for the D9 loopback two-machine drill files (2026-09-25 split).
 *
 * The drill used to be ONE file with seven serial top-level tests (~45s of wall clock, the
 * single biggest lan-sync hotspot — the in-file `concurrency` option was measured on this host
 * and made the FULL suite slower, because `node --test` already saturates the cores with
 * file-level workers and extra in-process drill processes just oversubscribe the CPU). The
 * tests were therefore SPLIT into sibling files instead: each still spawns its OWN side
 * processes (ephemeral ports, mkdtemp dirs, per-process db singleton), so file-level
 * parallelism distributes them across the worker pool without extra concurrent load.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SIDE = path.join(here, 'd9-drill-side.mjs')
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function launch () {
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
export async function startSide (deviceId, absDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-'))) {
  const side = launch()
  const r = await side.send({ do: 'start', dir: absDir, deviceId })
  assert.ok(!r.error, 'side start failed: ' + (r.error || ''))
  const p = await side.send({ do: 'port' })
  assert.ok(!p.error, 'side port failed: ' + (p.error || ''))
  return { ...side, port: p.port, deviceId, absDir }
}

/** Bounded converge loop: rounds on `driver` until `pred` (a getAll read on `reader`) holds. */
export async function waitFor (driver, reader, pred, label) {
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

export const write = (side, ops) => side.send({ do: 'write', ops })
export const task = (id, content, updateTime, extra = {}) => ({ op: 'upsertMany', params: [{ taskId: id, taskContent: content, categoryId: null, complete: false, delete: false, updateTime, ...extra }] })
export const readAll = async side => (await side.send({ do: 'read', op: 'getAll', params: { deleted: null } })).result || []
export const pair = (a, b) => {
  a.send({ do: 'addPeer', peer: { deviceId: b.deviceId, host: '127.0.0.1', port: b.port } })
  b.send({ do: 'addPeer', peer: { deviceId: a.deviceId, host: '127.0.0.1', port: a.port } })
}
