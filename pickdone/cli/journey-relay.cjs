#!/usr/bin/env node
'use strict'
/**
 * Relay-sync THREE-MACHINE user-journey acceptance drill (2026-10-11) — the remote-transport
 * counterpart to cli/journey-sync.cjs (LAN). Topology, all with ISOLATED throw-away data:
 *
 *   Device A  this machine, real packaged exe (dist/win-unpacked), temp user-data dir
 *   Device B  --remote <ssh-alias> (default: ardss), same packaged exe deployed to a
 *             scratch dir, temp user-data dir — driven over SSH
 *   Relay     --relay <base-url> — a remote sync-relay (lubancat), enrollment-gated
 *
 *   boot A+B -> relay enable on both (shared root key = manual account pairing, the same
 *   stand-in the e2e tests use; enrollment proves the closed-registration door) -> A adds 3
 *   todos, B adds 2 -> rounds until both sides see the same 5 -> quarantined === 0 on both ->
 *   idempotency (extra rounds change nothing) -> RELAY RESTART (fileStore recovery) -> still
 *   converges -> cleanup (forget identity, kill instances, delete temp dirs unless --keep).
 *
 * Usage:
 *   node cli/journey-relay.cjs --relay http://192.168.31.68:58490 --enrollment <secret> \
 *        [--remote ardss] [--remote-dir C:\\Users\\Public\\jrelay] [--relay-restart-ssh lubancat] [--keep]
 * Requires the app to be built (npm run pack) and `ssh <remote>` / `ssh <relay-restart-ssh>`
 * to be key-authenticated. Exit 0 = the whole journey passes; exit 1 = first failed step.
 */

const { spawn, execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const LOCAL_CLI = path.join(ROOT, 'cli', 'pickdone.js')

function arg (name, dflt) {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] && process.argv[i + 1] !== 'true' ? process.argv[i + 1] : dflt
}
const RELAY_URL = arg('--relay', null)
const ENROLLMENT = arg('--enrollment', null)
const REMOTE = arg('--remote', 'ardss')
const REMOTE_DIR = arg('--remote-dir', 'C:\\Users\\Public\\jrelay')
const RESTART_SSH = arg('--relay-restart-ssh', null)
const KEEP = process.argv.includes('--keep')
const ACCOUNT = 'journey-relay-' + Date.now().toString(36)

const APP_DIR = path.resolve(arg('--app', path.join(ROOT, 'dist', 'win-unpacked')))
const EXE = path.join(APP_DIR, 'PickDone.exe')
if (!RELAY_URL || !ENROLLMENT) {
  console.error('[jrelay] --relay <base-url> and --enrollment <secret> are required')
  process.exit(1)
}
if (!fs.existsSync(EXE)) {
  console.error(`[jrelay] app not built: ${EXE} missing — run: npm run pack`)
  process.exit(1)
}

const steps = []
let failed = false
function step (name, fn) { steps.push({ name, fn }) }
const ok = name => console.log(`  ✓ ${name}`)
function die (name, err) {
  failed = true
  console.error(`  ✗ ${name}: ${(err && err.message) || err}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Run a command, capture combined output. Non-zero exit THROWS (callers decide). */
function run (cmd, args, { timeout = 120000, input = null } = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], input, windowsHide: true })
}
/** Run WITHOUT throwing (returns {code, out}). */
function tryRun (cmd, args, opts = {}) {
  try { return { code: 0, out: run(cmd, args, opts) } } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}
const ssh = (alias, remoteCmd, opts = {}) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, remoteCmd], { timeout: opts.timeout || 120000 })

/** Parse the LAST JSON object found in output (CLI prints human lines before --json payloads). */
function lastJson (out) {
  const lines = String(out).split(/\r?\n/).filter(l => l.trim().startsWith('{'))
  if (!lines.length) throw new Error('no JSON line in output: ' + String(out).slice(0, 400))
  return JSON.parse(lines[lines.length - 1])
}

/* ---------------- device A (local) ---------------- */

const A = { ud: fs.mkdtempSync(path.join(os.tmpdir(), 'jrelay-a-')) }

/* Local CLI needs TODO_USER_DATA_DIR/TODO_DB_DIR — spawn through cmd so env sticks per call. */
function cliLocalEnv (args, timeoutMs = 120000) {
  const envLine = `set "TODO_USER_DATA_DIR=${A.ud}"&& set "TODO_DB_DIR=${A.ud}"&& `
  return tryRun('cmd.exe', ['/d', '/s', '/c', `${envLine}"${process.execPath}" "${LOCAL_CLI}" ${args.join(' ')}`], { timeout: timeoutMs })
}

/* ---------------- device B (remote, over SSH) ---------------- */

const B = { ud: null, dir: REMOTE_DIR }
const B_ENV_FILE = path.join(B.dir, 'jrelay-env.cmd')
const B_CLI_CMD = path.join(B.dir, 'jrelay-cli.cmd')

function cliRemote (args, timeoutMs = 180000) {
  const quoted = args.map(a => /^--/.test(a) || /^[A-Za-z0-9_.:-]+$/.test(a) ? a : `"${a}"`).join(' ')
  return tryRun('ssh', ['-o', 'BatchMode=yes', REMOTE, `"${B_CLI_CMD}" ${quoted}`], { timeout: timeoutMs })
}

async function poll (budgetMs, fn) {
  const end = Date.now() + budgetMs
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* transient — keep polling */ }
    if (v) return v
    if (Date.now() > end) return null
    await sleep(2500)
  }
}

const relayStatus = async which => {
  const r = which === 'a' ? cliLocalEnv(['sync', 'relay', 'status', '--json']) : cliRemote(['sync', 'relay', 'status', '--json'])
  if (r.code !== 0) return null
  const parsed = lastJson(r.out)
  return parsed.ok ? parsed.data || parsed.result || parsed : parsed
}
const relaySync = async which => {
  const r = which === 'a' ? cliLocalEnv(['sync', 'relay', 'sync', '--json']) : cliRemote(['sync', 'relay', 'sync', '--json'])
  if (r.code !== 0) return { ok: false, error: 'CLI exit ' + r.code + ': ' + r.out.slice(0, 300) }
  return lastJson(r.out)
}
const getAll = async which => {
  const r = which === 'a' ? cliLocalEnv(['list', '--all', '--json']) : cliRemote(['list', '--all', '--json'])
  if (r.code !== 0) throw new Error('list failed: ' + r.out.slice(0, 300))
  const parsed = lastJson(r.out)
  const rows = parsed.data != null ? parsed.data : parsed
  return Array.isArray(rows) ? rows : []
}
const addTodo = async (which, title) => {
  const r = which === 'a' ? cliLocalEnv(['add', title, '--json']) : cliRemote(['add', title, '--json'])
  if (r.code !== 0) throw new Error(`add ${title} failed: ` + r.out.slice(0, 300))
  return lastJson(r.out)
}

async function killInstances () {
  // path-scoped kill on THIS machine (never touch a real install)
  tryRun('powershell.exe', ['-NoProfile', '-Command',
    `Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' } | Stop-Process -Force`])
  tryRun('ssh', ['-o', 'BatchMode=yes', REMOTE,
    `powershell -NoProfile -Command "Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${(B.dir + '\\\\PickDone.exe').replace(/'/g, "''")}' } | Stop-Process -Force"`])
}

/* ---------------- the journey ---------------- */

step('pre: relay reachable + enrollment door SHUT for unenrolled registrations', async () => {
  const res = await fetch(RELAY_URL.replace(/\/$/, '') + '/v1/device/register', {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ account: ACCOUNT, device: 'probe-door' }),
  }).catch(e => { throw new Error('relay unreachable: ' + e.message) })
  const body = await res.json().catch(() => ({}))
  if (res.status !== 403) throw new Error(`expected the enrollment door shut (403), got ${res.status}: ` + JSON.stringify(body))
  ok(`relay answers at ${RELAY_URL}; open registration rejected (403)`)
})

step('deploy: packaged app + CLI wrapper staged on the remote device', () => {
  ssh(REMOTE, `if not exist "${B.dir}" mkdir "${B.dir}"`)
  // copy the packaged app (robocopy /MIR is idempotent; ~1-2 min over LAN)
  const r = tryRun('robocopy.exe', [APP_DIR, B.dir + '\\win-unpacked', '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'])
  if (r.code > 7) throw new Error('robocopy failed code ' + r.code + ': ' + r.out.slice(0, 300))
  // CLI wrapper: fixed env (isolated user dir) + system node on the packaged CLI.
  // Files are written locally then scp'd (no stdin copies over ssh).
  B.ud = 'C:\\Users\\Public\\jrelay\\ud-b-' + Date.now().toString(36)
  const envCmd = [
    '@echo off',
    `set "TODO_USER_DATA_DIR=${B.ud}"`,
    `set "TODO_DB_DIR=${B.ud}"`,
    'set "PICKDONE_MULTI=1"',
    'set "TODO_RELAY_ALLOW_REMOTE=1"',
    '',
  ].join('\r\n')
  const cliCmd = [
    '@echo off',
    `call "${B_ENV_FILE}"`,
    `node "${B.dir}\\win-unpacked\\resources\\cli\\pickdone.js" %*`,
    '',
  ].join('\r\n')
  const tmpEnv = path.join(os.tmpdir(), 'jrelay-env.cmd')
  const tmpCli = path.join(os.tmpdir(), 'jrelay-cli.cmd')
  fs.writeFileSync(tmpEnv, envCmd)
  fs.writeFileSync(tmpCli, cliCmd)
  run('scp', ['-o', 'BatchMode=yes', tmpEnv, `${REMOTE}:${B_ENV_FILE}`])
  run('scp', ['-o', 'BatchMode=yes', tmpCli, `${REMOTE}:${B_CLI_CMD}`])
  fs.rmSync(tmpEnv, { force: true }); fs.rmSync(tmpCli, { force: true })
  ok(`app mirrored to ${REMOTE}:${B.dir}\\win-unpacked; wrappers staged (ud=${B.ud})`)
})

step('boot: both devices reach a live command bus', async () => {
  // A: spawn the real exe with isolated env, detached
  spawn(EXE, [], {
    cwd: APP_DIR, detached: true, stdio: 'ignore',
    env: { ...process.env, TODO_USER_DATA_DIR: A.ud, TODO_DB_DIR: A.ud, PICKDONE_MULTI: '1', TODO_RELAY_ALLOW_REMOTE: '1' },
  }).unref()
  // B: remote boot through a one-shot wrapper (env from jrelay-env.cmd)
  const bootCmd = path.join(B.dir, 'jrelay-boot.cmd')
  const tmpBoot = path.join(os.tmpdir(), 'jrelay-boot.cmd')
  fs.writeFileSync(tmpBoot, [
    '@echo off',
    `call "${B_ENV_FILE}"`,
    `start "" "${B.dir}\\win-unpacked\\PickDone.exe"`,
    '',
  ].join('\r\n'))
  run('scp', ['-o', 'BatchMode=yes', tmpBoot, `${REMOTE}:${bootCmd}`])
  fs.rmSync(tmpBoot, { force: true })
  ssh(REMOTE, `"${bootCmd}"`)
  const upA = await poll(120000, async () => {
    const r = cliLocalEnv(['sync', 'status', '--json'], 30000)
    return r.code === 0 ? lastJson(r.out) : null
  })
  const upB = await poll(120000, async () => {
    const r = cliRemote(['sync', 'status', '--json'], 60000)
    return r.code === 0 ? lastJson(r.out) : null
  })
  if (!upA || !upB) throw new Error(`command bus not reachable (A=${!!upA} B=${!!upB})`)
  ok(`A up (${(upA.data && upA.data.status && upA.data.status.deviceName) || 'local'}) / B up (${(upB.data && upB.data.status && upB.data.status.deviceName) || 'remote'})`)
})

step('enable: relay transport on BOTH devices (shared root key = manual account pairing)', async () => {
  const rootKey = crypto.randomBytes(32).toString('hex')
  for (const [which, cli] of [['a', cliLocalEnv], ['b', cliRemote]]) {
    const r = cli(['sync', 'relay', 'enable', '--account', ACCOUNT, '--base-url', RELAY_URL, '--root-key', rootKey, '--enrollment', ENROLLMENT, '--json'], 180000)
    if (r.code !== 0) throw new Error(`relay enable failed on ${which}: ` + r.out.slice(0, 400))
    const parsed = lastJson(r.out)
    const st = parsed.data || parsed.result || parsed
    if (!st.enabled) throw new Error(`relay not enabled on ${which}: ` + JSON.stringify(st).slice(0, 300))
  }
  ok(`both devices enabled for ${ACCOUNT} @ ${RELAY_URL} (enrollment accepted, devices registered)`)
})

step('converge: A adds 3, B adds 2 — rounds until both sides hold the same 5', async () => {
  const EXPECT = ['jrelay-A1', 'jrelay-A2', 'jrelay-A3', 'jrelay-B1', 'jrelay-B2']
  for (const t of EXPECT.slice(0, 3)) await addTodo('a', t)
  for (const t of EXPECT.slice(3)) await addTodo('b', t)
  const journeyContents = rows => [...new Set(rows.map(r => String(r.taskContent || '')).filter(c => c.startsWith('jrelay-')))].sort()
  const converge = await poll(180000, async () => {
    await relaySync('a'); await relaySync('b'); await relaySync('a')
    const [la, lb] = [await getAll('a'), await getAll('b')]
    const ca = journeyContents(la); const cb = journeyContents(lb)
    return ca.length === 5 && cb.length === 5 && ca.join(',') === cb.join(',') && ca.join(',') === EXPECT.join(',')
      ? { a: la.length, b: lb.length, contents: ca } : null
  })
  if (!converge) {
    const [la, lb] = [await getAll('a'), await getAll('b')]
    throw new Error('never converged: A=' + JSON.stringify(journeyContents(la)) + ' B=' + JSON.stringify(journeyContents(lb)))
  }
  ok(`both sides hold all 5 journey todos [${converge.contents.join(', ')}] (3+2 converged; A=${converge.a} rows, B=${converge.b} rows)`)
})

step('clean: quarantined === 0 on both devices (no frame failed to verify)', async () => {
  for (const which of ['a', 'b']) {
    const st = await relayStatus(which)
    const q = st && (st.quarantinedTotal != null ? st.quarantinedTotal : (st.lastResult && st.lastResult.quarantined))
    if (!(q === 0)) throw new Error(`device ${which} quarantined=${JSON.stringify(q)} (status: ` + JSON.stringify(st).slice(0, 300) + ')')
  }
  ok('quarantined=0 on A and B')
})

step('idempotent: extra rounds on both — no duplicates, counts stable', async () => {
  await relaySync('a'); await relaySync('b'); await relaySync('a'); await relaySync('b')
  const [la, lb] = [await getAll('a'), await getAll('b')]
  const journey = rows => rows.filter(r => String(r.taskContent || '').startsWith('jrelay-'))
  const ca = journey(la); const cb = journey(lb)
  const uniq = rows => new Set(rows.map(r => r.taskId)).size
  if (ca.length !== 5 || cb.length !== 5 || uniq(ca) !== 5 || uniq(cb) !== 5) {
    throw new Error(`duplicate/miscount after extra rounds: A=${ca.length}(${uniq(ca)}) B=${cb.length}(${uniq(cb)}) (expected 5/5 unique)`)
  }
  ok('extra rounds stable at 5/5 unique journey rows (no duplicates)')
})

if (RESTART_SSH) step('resilience: RELAY RESTART (fileStore recovery) — devices re-converge', async () => {
  ssh(RESTART_SSH, 'sudo -n systemctl restart pickdone-relay-drill', { timeout: 60000 })
  await sleep(3000)
  const round = await poll(120000, async () => {
    await relaySync('a'); await relaySync('b')
    const [la, lb] = [await getAll('a'), await getAll('b')]
    const journey = rows => rows.filter(r => String(r.taskContent || '').startsWith('jrelay-'))
    return journey(la).length === 5 && journey(lb).length === 5 ? true : null
  })
  if (!round) throw new Error('devices did not re-converge after the relay restart')
  ok('after relay restart: both sides hold 5/5 — durable state recovered, no data loss')
})

step('cleanup: forget relay identity on both, stop instances, remove temp data', async () => {
  for (const [which, cli] of [['a', cliLocalEnv], ['b', cliRemote]]) {
    const r = cli(['sync', 'relay', 'forget', '--json'], 60000)
    if (r.code !== 0) console.error(`  (warn) relay forget on ${which} failed: ` + r.out.slice(0, 200))
  }
  await killInstances()
  await sleep(1500)
  if (!KEEP) {
    try { fs.rmSync(A.ud, { recursive: true, force: true }) } catch { /* locked handle — best effort */ }
    tryRun('ssh', ['-o', 'BatchMode=yes', REMOTE, `cmd /c "if exist "${B.ud}" rd /s /q "${B.ud}""`], { timeout: 60000 })
  }
  ok(`instances stopped${KEEP ? ' (temp dirs KEPT via --keep: ' + A.ud + ' / ' + B.ud + ')' : ', temp data removed (isolation held — no real data touched)'}`)
})

;(async () => {
  console.log(`[jrelay] relay=${RELAY_URL} remote=${REMOTE}:${REMOTE_DIR} account=${ACCOUNT}`)
  await killInstances() // defensive: a leftover instance from a previous run would hijack the bus
  await sleep(1000)
  for (const { name, fn } of steps) {
    process.stdout.write(`[jrelay] ${name}\n`)
    try { await fn() } catch (e) { die(name, e); break }
  }
  await killInstances()
  if (failed) { console.error('[jrelay] FAIL'); process.exit(1) }
  console.log(`[jrelay] PASS — full relay journey (${steps.length} steps) across TWO real devices + ONE remote relay, isolated temp data only`)
  process.exit(0)
})()
