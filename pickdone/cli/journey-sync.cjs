#!/usr/bin/env node
'use strict'
/**
 * LAN-sync USER-JOURNEY acceptance drill (2026-10-10) — the systematic counterpart to
 * whack-a-mole bug fixing. Walks the full user journey across TWO REAL app instances on this
 * machine (isolated data dirs, real TCP/mDNS/DB), the same path a user's devices take:
 *
 *   boot A + B -> enable sync on both -> discovery: each side lists the other as a NEARBY
 *   (announced, unpaired) device -> pair A->B (B answers over the command bus) -> A adds a task,
 *   B receives it -> B adds a task, A receives it (bidirectional convergence, syncAuthor
 *   cross-attributed) -> unpair -> both peer lists drain.
 *
 * Usage:
 *   node cli/journey-sync.cjs [--app <win-unpacked dir>] [--keep]
 * Requires the app to be built (npm run pack) — it boots the packaged exe, not dev vite.
 * Exit 0 = the whole journey passes; exit 1 = first failed step (printed).
 */

const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'cli', 'pickdone.js')

function arg (name, dflt) {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const APP_DIR = path.resolve(arg('--app', path.join(ROOT, 'dist', 'win-unpacked')))
const EXE = path.join(APP_DIR, process.platform === 'win32' ? 'PickDone.exe' : 'pickdone')
const KEEP = process.argv.includes('--keep')

if (!fs.existsSync(EXE)) {
  console.error(`[journey] app not built: ${EXE} missing — run: npm run pack`)
  process.exit(1)
}

const steps = []
let failed = false
function step (name, fn) {
  steps.push({ name, fn })
}
function ok (name) { console.log(`  ✓ ${name}`) }
function die (name, err) {
  failed = true
  console.error(`  ✗ ${name}: ${err && err.message || err}`)
}

function cli (udDir, args, timeoutMs = 90_000) {
  // shell out to the real CLI so the drill exercises the exact command surface an operator uses
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, TODO_USER_DATA_DIR: udDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', () => {
      // some commands (sync pair) print a human line BEFORE the JSON — parse from the first '{'
      const i = out.indexOf('{')
      try { resolve(JSON.parse(out.slice(i))) } catch { resolve({ ok: false, raw: out }) }
    })
  })
}

function makeInstance (tag, port) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), `journey-${tag}-`))
  const env = {
    ...process.env,
    TODO_USER_DATA_DIR: ud,
    TODO_DB_DIR: ud,
    PICKDONE_MULTI: '1',
    TODO_SYNC_PORT: String(port),
  }
  const child = spawn(EXE, [], { env, cwd: APP_DIR, detached: true, stdio: 'ignore' })
  child.unref()
  return { tag, ud, port, pid: child.pid, child }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Poll until fn(data) is truthy (bus/boot readiness) or budget runs out. */
async function poll (budgetMs, fn) {
  const end = Date.now() + budgetMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(2000)
  }
}
const status = async inst => {
  const r = await cli(inst.ud, ['sync', 'status', '--json'])
  return r.ok ? (r.data.status || r.data) : null
}

async function killInstance (inst) {
  if (process.platform !== 'win32') { try { inst.child.kill() } catch {} return }
  // path-scoped kill: never touch another PickDone on the machine (the user's own install)
  try {
    execSync(`powershell -NoProfile -Command "Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' } | Stop-Process -Force"`, { stdio: 'ignore' })
  } catch { /* already gone */ }
  if (!KEEP) { try { fs.rmSync(inst.ud, { recursive: true, force: true }) } catch {} }
}

/* ---------------- the journey ---------------- */

step('boot: both instances reach a live command bus', async ctx => {
  ctx.a = makeInstance('a', 58481)
  ctx.b = makeInstance('b', 58482)
  const upA = await poll(90_000, async () => (await status(ctx.a)) !== null)
  const upB = await poll(90_000, async () => (await status(ctx.b)) !== null)
  if (!upA || !upB) throw new Error(`bus not reachable (A=${!!upA} B=${!!upB})`)
  ok(`A up (${upA.deviceName || ctx.a.tag}) / B up (${upB.deviceName || ctx.b.tag})`)
})

step('enable: sync turns on headlessly and both nodes listen', async ctx => {
  for (const inst of [ctx.a, ctx.b]) {
    const r = await cli(inst.ud, ['sync', 'enable', '--json'])
    if (!r.ok) throw new Error(`sync enable failed on ${inst.tag}: ${r.error || r.raw}`)
  }
  await sleep(1500)
  const sa = await status(ctx.a); const sb = await status(ctx.b)
  if (!sa.listening || !sb.listening) throw new Error(`listening failed (A=${sa.listening} B=${sb.listening})`)
  ok(`A :${sa.port} / B :${sb.port} both listening`)
})

step('discover: each side lists the other as a NEARBY (unpaired) device', async ctx => {
  const seen = await poll(60_000, async () => {
    const sa = await status(ctx.a); const sb = await status(ctx.b)
    const aSeesB = (sa.discovered || []).some(d => d.deviceId === sb.deviceId)
    const bSeesA = (sb.discovered || []).some(d => d.deviceId === sa.deviceId)
    return aSeesB && bSeesA ? { aSeesB, bSeesA } : null
  })
  if (!seen) throw new Error('mutual discovery never converged — check mDNS/UDP announce')
  ok('A sees B nearby AND B sees A nearby')
})

step('pair: A dials, B answers over the command bus, both adopt the shared secret', async ctx => {
  const sb = await status(ctx.b)
  const pairP = cli(ctx.a.ud, ['sync', 'pair', '--host', '127.0.0.1', '--port', String(sb.port), '--timeout', '75', '--json'], 100_000)
  await sleep(4000) // let the request surface as pendingPair on B
  const resp = await cli(ctx.b.ud, ['sync', 'pair-respond', '--json'])
  if (!resp.ok) throw new Error('B pair-respond failed: ' + (resp.error || resp.raw))
  const pa = await pairP
  if (!pa.ok) throw new Error('A pair failed: ' + (pa.error || pa.raw))
  ok('paired: shared secret adopted on both sides')
})

step('converge A->B: A adds a task, B receives it with the right syncAuthor', async ctx => {
  const sa = await status(ctx.a)
  const add = await cli(ctx.a.ud, ['add', 'journey-A-task', '--json'])
  if (!add.ok) throw new Error('A add failed: ' + (add.error || add.raw))
  const got = await poll(60_000, async () => {
    const q = await cli(ctx.b.ud, ['search', 'journey-A-task', '--json'])
    const hits = (q.data && (q.data.results || q.data)) || []
    return hits.length ? hits : null
  })
  if (!got) throw new Error('task from A never reached B')
  if (!String(got[0].syncAuthor || '').includes(sa.deviceId)) throw new Error('syncAuthor not attributed to A')
  ok(`B received "${got[0].taskContent}" authored by A`)
})

step('converge B->A: same in the other direction', async ctx => {
  const sb = await status(ctx.b)
  const add = await cli(ctx.b.ud, ['add', 'journey-B-task', '--json'])
  if (!add.ok) throw new Error('B add failed: ' + (add.error || add.raw))
  const got = await poll(60_000, async () => {
    const q = await cli(ctx.a.ud, ['search', 'journey-B-task', '--json'])
    const hits = (q.data && (q.data.results || q.data)) || []
    return hits.length ? hits : null
  })
  if (!got) throw new Error('task from B never reached A')
  if (!String(got[0].syncAuthor || '').includes(sb.deviceId)) throw new Error('syncAuthor not attributed to B')
  ok(`A received "${got[0].taskContent}" authored by B`)
})

step('quiesce: rounds drain, pending=0 on both sides', async ctx => {
  const drained = await poll(60_000, async () => {
    const sa = await status(ctx.a); const sb = await status(ctx.b)
    const pa = (sa.peers || []).every(p => p.pendingCount === 0)
    const pb = (sb.peers || []).every(p => p.pendingCount === 0)
    return pa && pb ? true : null
  })
  if (!drained) throw new Error('pending never drained to 0')
  ok('both sides fully caught up')
})

step('unpair: A unpairs — A drains; B keeps a zombie card in the unpaired-by-remote state', async ctx => {
  const sa = await status(ctx.a)
  const peer = (sa.peers || [])[0]
  if (!peer) throw new Error('no peer to unpair')
  const r = await cli(ctx.a.ud, ['sync', 'unpair', '--device', peer.deviceId, '--json'])
  if (!r.ok) throw new Error('unpair failed: ' + (r.error || r.raw))
  const settled = await poll(30_000, async () => {
    const a2 = await status(ctx.a); const b2 = await status(ctx.b)
    // A removes the peer outright; B is DESIGNED to keep the card (P2c): it shows the
    // "unpaired by the other device" state so the user knows to re-pair, not a silent vanish.
    const aDrained = (a2.peers || []).length === 0
    const bZombie = (b2.peers || []).some(p => p.peerState === 'unpaired' || /unpair|unauthorized/i.test(String(p.lastError || '')))
    return aDrained && bZombie ? true : null
  })
  if (!settled) throw new Error('unpair did not settle: A must drain, B must show the unpaired-by-remote zombie state')
  ok('A drained; B shows the re-pair-needed zombie card (by design)')
})

;(async () => {
  const ctx = {}
  console.log(`[journey] app: ${EXE}`)
  for (const { name, fn } of steps) {
    process.stdout.write(`[journey] ${name}\n`)
    try { await fn(ctx) } catch (e) { die(name, e); break }
  }
  await Promise.all([ctx.a, ctx.b].filter(Boolean).map(killInstance))
  if (failed) { console.error('[journey] FAIL'); process.exit(1) }
  console.log(`[journey] PASS — full user journey (${steps.length} steps) across two real instances`)
  process.exit(0)
})()
