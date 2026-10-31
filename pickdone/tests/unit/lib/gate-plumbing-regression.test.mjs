/**
 * gate-plumbing regression (2026-10-31 fix wave) — reproducibility tests for the four
 * gate-plumbing fixes that shipped together:
 *   P0  child-registry per-pid write/rm (concurrent lanes no longer prune each other)
 *   P0  PICKDONE_CHILD_REGISTRY_DIR sandbox override (meta#2 leak assertion de-polluted)
 *   P2  run-all flake-retry 30s settle only for ledger-known flake suspects
 *   P2  composed TAP `# pass` in test-point units + plan-anchored `# pass` read in
 *       cli/check-test-summary.cjs
 *
 * All registry exercises run against PRIVATE temp dirs via the env override — the real
 * tests/.artifacts/runner-children dir is never written.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const REG_MOD_URL = pathToFileURL(path.join(PICKDONE, 'tests', 'lib', 'child-registry.mjs')).href
const RUN_ALL = path.join(PICKDONE, 'tests', 'run-all.mjs')
const REAL_REG_DIR = path.join(PICKDONE, 'tests', '.artifacts', 'runner-children')

const tmpDir = label => fs.mkdtempSync(path.join(os.tmpdir(), 'reg-plumb-' + label + '-'))

/** Lane process: registers (and optionally unregisters) a batch of fake pids in its registry dir. */
const LANE_SCRIPT = `
const r = await import(process.env.REG_MOD_URL)
const pids = JSON.parse(process.env.REG_PIDS)
for (const pid of pids) {
  r.registerChild(pid, { match: [], purpose: 'gate-plumbing regression lane' })
  await new Promise(res => setTimeout(res, 15))
}
if (process.env.REG_UNREGISTER_ALL === '1') for (const pid of pids) r.unregisterChild(pid)
`
const runLane = (regDir, pids, extraEnv = {}) => spawnSync(process.execPath,
  ['--input-type=module', '-e', LANE_SCRIPT],
  { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, REG_MOD_URL, REG_PIDS: JSON.stringify(pids), PICKDONE_CHILD_REGISTRY_DIR: regDir, ...extraEnv } })

test('P0: two concurrent register lanes never prune each other (per-pid files, no RMW)', async () => {
  const reg = tmpDir('concurrent')
  const laneA = [970000001, 970000002, 970000003, 970000004, 970000005, 970000006]
  const laneB = [980000001, 980000002, 980000003, 980000004, 980000005, 980000006]
  // run the two lanes CONCURRENTLY: with the old read-dir->prune->rewrite writeAll, each
  // register deleted every file the interleaved other lane had just written, so the losing
  // lane's children became unreapable orphans (final count ~6, not 12).
  await Promise.all([laneA, laneB].map(pids => new Promise(res => {
    const pids_ = pids
    const c = spawn(process.execPath, ['--input-type=module', '-e', LANE_SCRIPT],
      { env: { ...process.env, REG_MOD_URL, REG_PIDS: JSON.stringify(pids_), PICKDONE_CHILD_REGISTRY_DIR: reg } })
    c.on('close', res)
  })))
  const files = fs.readdirSync(reg).filter(f => f.endsWith('.json'))
  assert.equal(files.length, 12, 'all 12 registrations from both interleaved lanes must survive: ' + files.join(','))
  for (const f of files) assert.match(fs.readFileSync(path.join(reg, f), 'utf8'), /"pid"/)
  fs.rmSync(reg, { recursive: true, force: true })
})

test('P0: unregister removes ONLY its own pid file; concurrent lane entries survive', () => {
  const reg = tmpDir('unregister')
  runLane(reg, [971000001, 971000002])
  // a second lane registers while (before) the first lane unregisters — old prune-based
  // unregister wiped every file not in its own snapshot
  runLane(reg, [981000001])
  runLane(reg, [971000001, 971000002], { REG_UNREGISTER_ALL: '1' })
  const files = fs.readdirSync(reg).filter(f => f.endsWith('.json'))
  assert.deepEqual(files.sort(), ['981000001.json'],
    'the other lane\'s entry must survive lane A\'s unregister')
  fs.rmSync(reg, { recursive: true, force: true })
})

test('P0: PICKDONE_CHILD_REGISTRY_DIR sandbox isolation — real registry never written', () => {
  const reg = tmpDir('isolation')
  const p = runLane(reg, [972000001])
  assert.equal(p.status, 0, p.stderr)
  assert.ok(fs.readdirSync(reg).includes('972000001.json'), 'the private dir receives the entry')
  const realFiles = fs.existsSync(REAL_REG_DIR) ? fs.readdirSync(REAL_REG_DIR) : []
  assert.ok(!realFiles.includes('972000001.json'), 'the REAL repo registry must stay untouched')
  fs.rmSync(reg, { recursive: true, force: true })
})

test('P0: readAll tolerates legacy/corrupt residue; cleanup removes only real entries', () => {
  const reg = tmpDir('residue')
  // legacy shared-JSON era: an ARRAY-shaped file; plus a torn write and a non-registry file
  fs.writeFileSync(path.join(reg, '999000001.json'),
    JSON.stringify([{ pid: 999000001, match: [], purpose: 'legacy array entry', owner: 1, bornAt: new Date().toISOString() }]))
  fs.writeFileSync(path.join(reg, 'torn.json'), '{"pid": 9990000')
  fs.writeFileSync(path.join(reg, 'notes.txt'), 'not a registry entry')
  const p = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const r = await import(process.env.REG_MOD_URL)
     const res = await r.cleanupRegisteredChildren()
     console.log('VERDICT:' + JSON.stringify({ gone: res.gone.length }))`],
    { encoding: 'utf8', timeout: 90000, env: { ...process.env, REG_MOD_URL, PICKDONE_CHILD_REGISTRY_DIR: reg } })
  assert.equal(p.status, 0, 'residue must never crash the registry: ' + p.stderr)
  assert.match(p.stdout, /VERDICT:(\{.*)/, 'cleanup reports its verdict')
  const left = fs.readdirSync(reg)
  assert.ok(!left.includes('999000001.json'), 'the processed legacy entry is removed')
  assert.ok(left.includes('torn.json') && left.includes('notes.txt'),
    'unparseable/non-registry files are left alone (no directory-wide prune)')
  fs.rmSync(reg, { recursive: true, force: true })
})

test('P2: deterministic first-time failure retries WITHOUT the 30s settle', () => {
  const dir = tmpDir('fastretry')
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'boom.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('boom', () => assert.equal(1, 0))\n")
  const t0 = Date.now()
  const p = spawnSync(process.execPath, [RUN_ALL],
    { cwd: dir, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEST_CONCURRENCY: '1', GATE_META_APP_ROOT: dir } })
  const wall = Date.now() - t0
  assert.equal(p.status, 1, 'a deterministic failure stays red')
  assert.match(p.stderr || '', /flake-retry/, 'the retry still runs (one shot)')
  assert.doesNotMatch(p.stderr || '', /30s settle/, 'no ledger history -> no 30s settle')
  assert.ok(wall < 25000, 'retry must not pay the 30s sleep (wall=' + wall + 'ms)')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('P2: composed flake-retry TAP counts # pass in TEST POINTS (not blocks-minus-skips)', () => {
  const dir = tmpDir('composed')
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  // ONE file with THREE test points: pass1 fails p1, retry passes all three — the composed
  // corpus must report `# pass` in the same unit as `# skip`/the plan's test points (the old
  // blocks-minus-skips formula diverged — even negative — under node-24 file-block wrapping).
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'flaky3.test.mjs'), [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "const marker = path.join(process.env.GATE_META_STATE, 'ran-once')",
    "test('p1', () => { if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); assert.fail('first run fails on purpose') } })",
    "test('p2', () => assert.equal(1, 1))",
    "test('p3', () => assert.equal(2, 2))",
  ].join('\n'))
  const p = spawnSync(process.execPath, [RUN_ALL],
    { cwd: dir, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEST_CONCURRENCY: '1', GATE_META_APP_ROOT: dir, GATE_META_STATE: path.join(dir, 'state') } })
  assert.equal(p.status, 0, 'the absorbed retry is green: ' + (p.stderr || '').slice(-400))
  // anchor the LAST plan (composed stream is authoritative), then verify the summary's UNIT
  // invariant: `# pass` must equal (test points - skips - not-ok points) computed over the
  // composed corpus — never blocks-minus-skips. On node versions that wrap each file into a
  // top-level block (node 24 real-pool runs), blocks != points and the old formula diverged
  // (even negative); on flat reporters both coincide, so the invariant is what we pin.
  const composed = (p.stdout || '').slice((p.stdout || '').lastIndexOf('COMPOSED-TAP-FOLLOWS'))
  const lines = composed.split(/\r?\n/)
  let planIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (/^1\.\.\d+\s*$/.test(lines[i])) { planIdx = i; break } }
  assert.ok(planIdx !== -1, 'a composed plan exists')
  const pts = re => lines.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0)
  const points = pts(/^\s*(?:not )?ok\b/)
  const skips = pts(/^\s*(?:not )?ok\b.*#\s*(?:SKIP|skip)\b/)
  const notOk = pts(/^\s*not ok\b/)
  const passStr = lines.slice(planIdx + 1).join('\n')
  const pass = /^# pass\s+(\d+)\s*$/m.exec(passStr)?.[1]
  assert.equal(pass, String(points - skips - notOk),
    `# pass must be the test-point count (${points - skips - notOk} = ${points}pts - ${skips}skip - ${notOk}fail)`)
  assert.ok(Number(pass) >= 3, 'the composed corpus carries at least the sandbox test points')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('P2: check-test-summary reads `# pass` from AFTER the last plan only', () => {
  const tap = tmpDir('pass-anchor') + '/in.tap'
  // a decoy `# pass 999` in the raw pass1 evidence region (before the authoritative plan)
  fs.writeFileSync(tap, [
    'TAP version 13',
    '# COMPOSED-TAP-FOLLOWS: consumers anchor the LAST plan (raw pass1 above is evidence)',
    '# pass 999',
    '1..2',
    'ok 1 a',
    'ok 2 b',
    '# pass 2',
    '# fail 0',
    '# cancelled 0',
    '# skip 0',
    '# todo 0',
    ''].join('\n'))
  const p = spawnSync(process.execPath, ['cli/check-test-summary.cjs', tap],
    { cwd: PICKDONE, encoding: 'utf8', timeout: 60000 })
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout || '', /# pass 2 \//, 'the pre-plan decoy `# pass 999` must be ignored')
  fs.rmSync(path.dirname(tap), { recursive: true, force: true })
})
