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
 * (tests/.artifacts/runner-children/<pid>.json, one file per child — override the dir with
 * PICKDONE_CHILD_REGISTRY_DIR for private/sandbox lanes) and removed when its 'close' event
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

// [2026-10-31 P0] PICKDONE_CHILD_REGISTRY_DIR: lets a lane (the gate-mechanics meta-suite in
// particular) point the registry at a PRIVATE dir so a concurrent real gate's registrations can
// never pollute its before/after leak assertions. Default stays anchored at the real location.
const REGISTRY_DIR = process.env.PICKDONE_CHILD_REGISTRY_DIR
  ? path.resolve(process.env.PICKDONE_CHILD_REGISTRY_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.artifacts', 'runner-children')

function entryFile (pid) { return path.join(REGISTRY_DIR, `${pid}.json`) }

// [2026-10-31] tolerant of legacy residue in the dir: array-shaped files from the pre-10-24
// shared-JSON era and corrupt/partial writes are skipped, never fatal.
function readAll () {
  let names = []
  try { names = fs.readdirSync(REGISTRY_DIR) } catch { return [] }
  const list = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const e = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'))
      // legacy tolerance: an old shared-JSON file may be an ARRAY of entries — flatten the
      // valid ones instead of dropping the whole file
      for (const entry of (Array.isArray(e) ? e : [e])) {
        if (entry && entry.pid) list.push(entry)
      }
    } catch { /* corrupt/partial entry from a concurrent writer — skip */ }
  }
  return list
}

// [2026-10-31 P0] writeAll (read-dir -> prune -> rewrite) is GONE. History note kept for the
// record: the 2026-10-24 per-pid file split removed the shared-JSON RMW, but writeAll kept a
// directory-wide PRUNE (delete every file not in the passed list) on every register/unregister.
// Two concurrent lanes interleaving register/unregister each serialized their own snapshot and
// the prune deleted the OTHER lane's entries registered in between — those children became
// unreapable orphans (2026-10-31 release-gate 5x red, drifting failure lineups: the meta#2
// half of that root cause is fixed in gate-mechanics.test.mjs). Now every process writes and
// removes ONLY its own per-pid files; nothing sweeps the directory except the deliberate
// --cleanup path, which removes exactly the entries it processed.

export function registryPath () { return REGISTRY_DIR }

/**
 * Record one child. `meta.match` is the list of literal fragments that MUST appear in the
 * live process command line for a later reap to be allowed to kill it — pass the most
 * distinctive argv you have (a flag pair, a script path, a unique --remote-debugging-port).
 */
export function registerChild (pid, meta = {}) {
  if (!pid) return
  // owner = the registering process: a NESTED run-all (check-test-scope-golden spawns one)
  // must never reap its parent's children at its own exit — each process reaps only what
  // it registered; --cleanup remains the deliberate sweep-everything path (2026-10-24).
  const entry = { pid, match: meta.match || [], purpose: meta.purpose || '', owner: process.pid, bornAt: new Date().toISOString() }
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    fs.writeFileSync(entryFile(pid), JSON.stringify(entry, null, 2) + '\n')
  } catch { /* best-effort by contract */ }
}

/** Prune one child (normal 'close' path — nothing left to reap). Removes ONLY that pid's file. */
export function unregisterChild (pid) {
  if (!pid) return
  try { fs.rmSync(entryFile(pid), { force: true }) } catch { /* raced */ }
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
    // [2026-10-31 P0] every processed entry's file is removed INDIVIDUALLY — no directory-wide
    // prune, so entries registered by a concurrent lane during the sweep are never deleted.
    try { fs.rmSync(entryFile(e.pid), { force: true }) } catch { /* raced */ }
  }
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
