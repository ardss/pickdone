#!/usr/bin/env node
/**
 * dev-duo (2026-10-01): launch TWO full app instances on ONE machine for manual LAN-sync
 * debugging, without ever touching the real %APPDATA% data dir.
 *
 * Prereqs wired elsewhere:
 *   - PICKDONE_MULTI=1 scopes the singleton lock per data dir (src/main/multi-instance.js,
 *     wired in src/main/index.js).
 *   - TODO_SYNC_PORT overrides the fixed 58471 transport port (src/main/lan-sync/transport.js).
 *   - Window title gets a per-dir [#hash] suffix (src/main/windows.js [TEST] badge path).
 *
 * Usage:
 *   node scripts/dev-duo.mjs            # launch A+B and leave them running (dirs reused if present)
 *   node scripts/dev-duo.mjs --keep     # same reuse guarantee, explicit
 *   node scripts/dev-duo.mjs --fresh    # wipe .tmp-duo first (fresh pair, re-pair from scratch)
 *   node scripts/dev-duo.mjs --verify   # launch, assert both CDP endpoints answer, kill OUR pids, exit
 *   node scripts/dev-duo.mjs --dry-run  # print the launch plan without starting anything
 *
 * Ports: CDP 9433 (A) / 9434 (B) — chosen to avoid the reserved 9333 (e2e) and any real user
 * instance; sync ports 58471 (A, default) / 58472 (B, TODO_SYNC_PORT).
 * Data dirs: .tmp-duo/instance-{a,b} are STABLE across restarts so pairing persists: pair once,
 * re-run with no flags and keep testing.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electronBin = process.platform === 'win32'
  ? path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron')

export function buildPlan ({ appRoot: root = appRoot, duoDir, fresh = false } = {}) {
  const base = duoDir || path.join(root, '.tmp-duo')
  const dirA = path.join(base, 'instance-a')
  const dirB = path.join(base, 'instance-b')
  const plan = {
    base, dirA, dirB, fresh,
    instances: [
      { name: 'A', userDataDir: dirA, cdpPort: 9433, syncPort: null },
      { name: 'B', userDataDir: dirB, cdpPort: 9434, syncPort: 58472 },
    ],
  }
  for (const inst of plan.instances) {
    inst.env = {
      ...process.env,
      PICKDONE_MULTI: '1',
      TODO_USER_DATA_DIR: inst.userDataDir,
      // keep TODO_DB_DIR out of the children: the data dir is owned by TODO_USER_DATA_DIR here
      TODO_DB_DIR: '',
      ...(inst.syncPort ? { TODO_SYNC_PORT: String(inst.syncPort) } : {}),
    }
    inst.args = ['.', `--remote-debugging-port=${inst.cdpPort}`]
    inst.cdpUrl = `http://127.0.0.1:${inst.cdpPort}/json/version`
  }
  return plan
}

function logPlan (plan) {
  console.log('[dev-duo] plan (no launch):')
  console.log(`  data dirs : ${plan.dirA}\n              ${plan.dirB}  ${plan.fresh ? '(wiped first)' : '(reused if present)'}`)
  for (const i of plan.instances) {
    console.log(`  [${i.name}] cdp=${i.cdpUrl} syncPort=${i.syncPort || '58471 (default)'}`)
    console.log(`  [${i.name}] env PICKDONE_MULTI=1 TODO_USER_DATA_DIR=${i.userDataDir}${i.syncPort ? ` TODO_SYNC_PORT=${i.syncPort}` : ''}`)
  }
}

async function cdpAlive (url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const body = await res.json()
    return !!(body && body.Browser)
  } catch { return false }
}

async function main () {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const verify = argv.includes('--verify')
  const fresh = argv.includes('--fresh')
  const keep = argv.includes('--keep') // explicit reuse; default already reuses — documented no-op
  const plan = buildPlan({ fresh })

  if (dryRun) { logPlan(plan); return 0 }

  if (!fs.existsSync(electronBin)) {
    console.error(`[dev-duo] electron binary not found at ${electronBin} — run npm install first`)
    return 1
  }
  if (fresh) {
    fs.rmSync(plan.base, { recursive: true, force: true })
    console.log(`[dev-duo] wiped ${plan.base}`)
  } else if (keep) {
    console.log(`[dev-duo] reusing existing data dirs under ${plan.base} (pairing persists)`)
  }
  for (const d of [plan.dirA, plan.dirB]) fs.mkdirSync(d, { recursive: true })

  // Spawn the REAL electron binary (no shell) so child.pid is the electron process itself —
  // these recorded pids are the ONLY thing --verify ever kills. Never kill by name: the user's
  // real instance may be running alongside (its sync port 58471 is theirs).
  const children = plan.instances.map(inst => {
    const child = spawn(electronBin, inst.args, { cwd: appRoot, env: inst.env, stdio: 'ignore', detached: false })
    console.log(`[dev-duo] [${inst.name}] pid=${child.pid} cdp=${inst.cdpUrl} syncPort=${inst.syncPort || '58471 (default)'}`)
    return { inst, pid: child.pid }
  })

  const WATCHDOG_MS = 30_000
  const deadline = Date.now() + WATCHDOG_MS
  const pending = new Set(children.map(c => c.inst.name))
  const killOurs = () => {
    for (const c of children) {
      try { process.kill(c.pid) } catch (e) { console.warn(`[dev-duo] kill pid ${c.pid}: ${e.message}`) }
    }
  }
  while (Date.now() < deadline && pending.size > 0) {
    for (const c of children) {
      if (!pending.has(c.inst.name)) continue
      if (await cdpAlive(c.inst.cdpUrl)) {
        pending.delete(c.inst.name)
        console.log(`[dev-duo] [${c.inst.name}] CDP is up: ${c.inst.cdpUrl}`)
      }
    }
    if (pending.size > 0) await new Promise(r => setTimeout(r, 500))
  }
  if (pending.size > 0) {
    console.error(`[dev-duo] WATCHDOG (${WATCHDOG_MS / 1000}s): no CDP answer from [${[...pending].join(', ')}]`)
    if (verify) { killOurs(); console.error('[dev-duo] --verify: killed our pids', children.map(c => c.pid).join(',')) }
    return 1
  }
  console.log(`[dev-duo] both instances are up. A: ${plan.dirA} (sync 58471) | B: ${plan.dirB} (sync 58472)`)
  if (verify) {
    killOurs()
    console.log(`[dev-duo] --verify: killed our pids ${children.map(c => c.pid).join(',')}`)
    return 0
  }
  console.log('[dev-duo] pair them once from the UI (Sync → pair); re-run without --fresh to reuse the pairing.')
  return 0
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(e => { console.error('[dev-duo] failed:', e); process.exit(1) })
}
