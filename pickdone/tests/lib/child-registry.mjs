/**
 * D4 orphan-hygiene child-pid registry (2026-10-23 speed wave).
 *
 * Incident class being closed: a gate runner (run-all / check-all / a live-pool boot)
 * that is SIGKILLed from the outside (watchdog, CI timeout, host OOM, agent kill) never
 * runs its own exit cleanup — its spawned children survive as unattributable orphans that
 * hold ports, DB locks and CPU until somebody notices. 2026-10-23 morning: the harness
 * kill left exactly such a tree behind.
 *
 * Contract: every long-lived child a gate spawns is REGISTERED HERE at spawn time
 * (tests/.artifacts/runner-children/<pid>.json, one file per child) and pruned when its 'close' event
 * fires. A runner that dies hard simply leaves its entries behind; `node tests/run-all.mjs
 * --cleanup` (or reapAllRegisteredSync from an exit handler) then reaps the survivors.
 *
 * Safety: a recorded pid is only killed when the LIVE process command line still matches
 * the fragments recorded at spawn time (pid reuse on a long-lived dev host would otherwise
 * turn a hygiene sweep into a random-process kill). Mismatched pids are reported as
 * `foreign` and left untouched — zero false-positive kills is the invariant.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REGISTRY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.artifacts', 'runner-children')

function entryFile (pid) { return path.join(REGISTRY_DIR, `${pid}.json`) }

function readAll () {
  let names = []
  try { names = fs.readdirSync(REGISTRY_DIR) } catch { return [] }
  const list = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const e = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'))
      if (e && e.pid) list.push(e)
    } catch { /* corrupt/partial entry from a concurrent writer — skip */ }
  }
  return list
}

function writeAll (list) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true })
  // 2026-10-24 (final18 orphan post-mortem): the registry used to be ONE shared JSON with a
  // read-modify-write cycle per register — concurrent gate pools (unit + live lanes spawn
  // electrons at the same time) lost updates to each other, and the losing lane's children
  // became unreapable orphans. One file PER registered pid now: no RMW, no lock, no loss.
  const keep = new Set(list.map(e => String(e.pid)))
  let names = []
  try { names = fs.readdirSync(REGISTRY_DIR) } catch { /* first use */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    if (!keep.has(name.slice(0, -5))) { try { fs.rmSync(path.join(REGISTRY_DIR, name), { force: true }) } catch { /* raced */ } }
  }
  for (const e of list) {
    try { fs.writeFileSync(entryFile(e.pid), JSON.stringify(e, null, 2) + '\n') } catch { /* best-effort */ }
  }
}

export function registryPath () { return REGISTRY_DIR }

/**
 * Record one child. `meta.match` is the list of literal fragments that MUST appear in the
 * live process command line for a later reap to be allowed to kill it — pass the most
 * distinctive argv you have (a flag pair, a script path, a unique --remote-debugging-port).
 */
export function registerChild (pid, meta = {}) {
  if (!pid) return
  const list = readAll().filter(e => e.pid !== pid)
  // owner = the registering process: a NESTED run-all (check-test-scope-golden spawns one)
  // must never reap its parent's children at its own exit — each process reaps only what
  // it registered; --cleanup remains the deliberate sweep-everything path (2026-10-24).
  list.push({ pid, match: meta.match || [], purpose: meta.purpose || '', owner: process.pid, bornAt: new Date().toISOString() })
  writeAll(list)
}

/** Prune one child (normal 'close' path — nothing left to reap). */
export function unregisterChild (pid) {
  if (!pid) return
  const list = readAll().filter(e => e.pid !== pid)
  writeAll(list)
}

const norm = s => String(s || '').replace(/^"|"$/g, '').replace(/\\/g, '/').toLowerCase()

/** Query live command lines for a batch of pids: Map<pid, commandLine|null>. */
function liveCmdlines (pids) {
  const out = new Map(pids.map(p => [p, null]))
  if (!pids.length) return out
  if (process.platform === 'win32') {
    const sel = pids.map(p => `$_.ProcessId -eq ${p}`).join(' -or ')
    const ps = `Get-CimInstance Win32_Process | Where-Object { ${sel} } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
    const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 })
    let rows = []
    try { rows = JSON.parse(r.stdout || '[]'); if (!Array.isArray(rows)) rows = [rows] } catch { /* none alive */ }
    for (const row of rows) out.set(Number(row.ProcessId), row.CommandLine || '')
  } else {
    for (const p of pids) {
      try {
        const raw = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')
        out.set(p, raw.replace(/\0/g, ' '))
      } catch { /* gone */ }
    }
  }
  return out
}

function matches (cmdline, fragments) {
  const live = norm(cmdline)
  return (fragments || []).every(f => live.includes(norm(f)))
}

function treeKill (pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 30000 })
    return r.status === 0
  }
  try { process.kill(pid, 'SIGKILL'); return true } catch { return false }
}

/**
 * Reap ONE registry entry. Returns 'killed' | 'gone' | 'foreign' (alive but command line
 * does not match the recorded fragments — pid reuse or tampering; NEVER killed) |
 * 'survivor' (matched but the kill itself failed).
 */
export function reapEntry (entry, cmdline) {
  const cmd = cmdline !== undefined ? cmdline : liveCmdlines([entry.pid]).get(entry.pid)
  if (cmd === null || cmd === undefined) return 'gone'
  if (!matches(cmd, entry.match)) return 'foreign'
  return treeKill(entry.pid) ? 'killed' : 'survivor'
}

/**
 * --cleanup mode: reap every registered child. Foreign pids are reported, not killed.
 * Returns { killed, gone, foreign, survivors } — survivors = matched pids that REFUSED
 * to die (kill command failed); the caller turns that into a red exit.
 */
export function cleanupRegisteredChildren () {
  const list = readAll()
  const lines = liveCmdlines(list.map(e => e.pid))
  const res = { killed: [], gone: [], foreign: [], survivors: [] }
  for (const e of list) {
    const v = reapEntry(e, lines.get(e.pid))
    if (v === 'killed') res.killed.push(e)
    else if (v === 'gone') res.gone.push(e)
    else if (v === 'foreign') res.foreign.push(e)
    else res.survivors.push(e)
  }
  writeAll([]) // processed: pruned (killed/gone); foreign pids are no longer ours to track
  return res
}

/**
 * Sync variant for process 'exit' handlers (must not touch the event loop): reaps every
 * entry THIS PROCESS registered (owner filter — a nested run-all's exit must not reap its
 * parent's children), best-effort, then clears the registry.
 */
export function reapAllRegisteredSync () {
  const mine = readAll().filter(e => e.owner === process.pid)
  if (process.env.GATE_META_DEBUG) console.error('[dbg reap] pid=' + process.pid + ' mine=' + JSON.stringify(mine))
  if (!mine.length) return
  const lines = liveCmdlines(mine.map(e => e.pid))
  if (process.env.GATE_META_DEBUG) console.error('[dbg reap] lines=' + JSON.stringify([...lines]))
  for (const e of mine) {
    let v = 'threw'
    try { v = reapEntry(e, lines.get(e.pid)) } catch (err) { v = 'threw: ' + err.message }
    if (process.env.GATE_META_DEBUG) console.error('[dbg reap] verdict ' + e.pid + ' = ' + v)
    try { fs.rmSync(entryFile(e.pid), { force: true }) } catch (err) { if (process.env.GATE_META_DEBUG) console.error('[dbg reap] rm failed: ' + err.message) }
  }
}
