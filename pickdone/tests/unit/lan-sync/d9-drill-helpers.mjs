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
import { pollUntil } from '../../lib/poll.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SIDE = path.join(here, 'd9-drill-side.mjs')
export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Spawn env WITHOUT any inherited TODO_DB_DIR/TODO_USER_DATA_DIR: the drill side owns its
 *  isolation env (set in its own head before the first production require). */
export function cleanSideEnv () {
  const env = { ...process.env }
  delete env.TODO_DB_DIR
  delete env.TODO_USER_DATA_DIR
  return env
}

export function launch () {
  // Log-isolation (2026-10-30): do NOT leak the parent test process's isolation env into the
  // side — the side sets its own per-process TODO_DB_DIR (d9-drill-side.mjs head) before any
  // production require; a blank slate here keeps that guarantee the single source of truth.
  const child = spawn(process.execPath, [SIDE], { stdio: ['pipe', 'pipe', 'inherit'], env: cleanSideEnv() })
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
    // [load-budget 2026-10-25] 15s was an idle-machine number: under a full gate (dozens of
    // concurrent test processes) a single IPC roundtrip+sync round can legitimately take
    // ~10s. The response shape is unchanged — a real hang still resolves via waitFor's
    // predicate deadline, this only stops the CPU-starved-but-healthy case from false-red.
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: 'side timeout' }) } }, 45000)
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

/** Bounded converge loop: rounds on `driver` until `pred` (a getAll read on `reader`) holds.
 *  [load-budget 2026-10-25] deadline 60s (was 12s, an idle-machine figure): the loop is a
 *  predicate poll — under a full gate the rounds converge slower but the PASS/FAIL semantics
 *  are untouched; a genuinely broken sync still exhausts the budget and throws.
 *  [signal-integrity 2026-10-25] dual threshold: converging past the old 12s budget is
 *  still a WORTHY signal (sync convergence-margin degradation) — it is recorded loudly on
 *  stderr, but does not flip the verdict (a slow-but-correct sync is a perf-debt signal,
 *  not a correctness red). */
export async function waitFor (driver, reader, pred, label) {
  const startedAt = Date.now()
  const deadline = Date.now() + 60000
  // [mainstream-alignment 2026-10-25] the polling loop now rides the shared
  // tests/lib/poll.mjs primitive (expect.poll shape) — the drill-specific parts
  // (3 sync kicks between probes, the convergence-margin margin signal) stay here.
  const rows = await pollUntil(async () => {
    for (let i = 0; i < 3; i++) {
      await driver.send({ do: 'round' })
      await sleep(150)
    }
    const r = await reader.send({ do: 'read', op: 'getAll', params: { deleted: null } })
    const rowsNow = r.result || []
    if (!pred(rowsNow)) {
      if (Date.now() > deadline) throw new Error('rows now: ' + JSON.stringify(rowsNow).slice(0, 600))
      return null
    }
    return rowsNow
  }, { timeoutMs: 60000, intervalMs: 50, label: 'drill: ' + label })
  const took = Date.now() - startedAt
  if (took > 12000) console.error(`[d9-drill] ⚠ convergence margin: '${label}' took ${took}ms (past the 12s legacy budget — sync convergence slowdown; perf-debt signal, not a red)`)
  return rows
}

export const write = (side, ops) => side.send({ do: 'write', ops })
export const task = (id, content, updateTime, extra = {}) => ({ op: 'upsertMany', params: [{ taskId: id, taskContent: content, categoryId: null, complete: false, delete: false, updateTime, ...extra }] })
export const readAll = async side => (await side.send({ do: 'read', op: 'getAll', params: { deleted: null } })).result || []
export const pair = (a, b) => {
  a.send({ do: 'addPeer', peer: { deviceId: b.deviceId, host: '127.0.0.1', port: b.port } })
  b.send({ do: 'addPeer', peer: { deviceId: a.deviceId, host: '127.0.0.1', port: a.port } })
}
