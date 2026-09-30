/** maint/d11r2 CLI round fixes (domain: cli-fixes), each with a regression test that fails without the fix:
 *  cli-2  `clean` joins GATED_WRITE and needs explicit --yes for the destructive pass
 *  cli-3  env-clean honors --all: the pickdone-backups repo-tree leak is opt-in only
 *  cli-4  purgeRecycleBin commits the row purge BEFORE deleting attachment files (rows-first)
 *  cli-5  events import validates HH:mm strictly; malformed events land in `failed`, not as tasks
 *  cli-6  importEvents result.hasRecord is a materialized boolean (was a live closure function)
 *  cli-7  lib-env packaged exe picker is deterministic (product-name first, sorted fallback)
 *  cli-15 sync pair fails fast on a null / !ok pairing-code ack instead of proceeding silently
 *  cli-16 deps rm of a non-predecessor errors instead of writing a no-op patch + audit row
 *  Isolated temp DB via TODO_DB_DIR / TODO_USER_DATA_DIR (d4/cli-r5 pattern). Subprocess tests
 *  get their own fresh temp dirs and never touch the real %APPDATA%/pickdone.
 *  Run: node --test tests/unit/cli/maint-cli-round2-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-maint-r2-db-')
process.env.TODO_USER_DATA_DIR = isolatedTmpDir('todo-maint-r2-ud-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const evu = require_('../../../cli/event-utils.cjs')
const envClean = require_('../../../cli/env-clean.js')
const libEnv = require_('../../../cli/lib-env.cjs')
const runSync = require_('../../../cli/lib-sync.cjs')
const userDirMod = require_('../../../src/main/user-dir.js')
const CLI = require_.resolve('../../../cli/pickdone.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

/* ================= cli-5: parseHHmm validator (pure) ================= */
test('cli-5: parseHHmm accepts real times, rejects garbage/out-of-range, honors allow24 only for 24:00', () => {
  assert.deepEqual(evu.parseHHmm('09:05'), { h: 9, m: 5 })
  assert.deepEqual(evu.parseHHmm('23:59'), { h: 23, m: 59 })
  assert.equal(evu.parseHHmm('9:xx'), null, 'was silently NaN-arithmetic before the fix')
  assert.equal(evu.parseHHmm('25:00'), null)
  assert.equal(evu.parseHHmm('12:60'), null)
  assert.equal(evu.parseHHmm('9'), null)
  assert.equal(evu.parseHHmm(''), null)
  assert.equal(evu.parseHHmm(null), null)
  assert.equal(evu.parseHHmm('24:00'), null, '24:00 without allow24 is not a start time')
  assert.deepEqual(evu.parseHHmm('24:00', { allow24: true }), { h: 24, m: 0 })
  assert.equal(evu.parseHHmm('24:01', { allow24: true }), null)
})

/* ================= cli-5: importEvents routes bad times to failed ================= */
test('cli-5: importEvents puts a malformed start time into failed and creates NO task', async () => {
  const yesterday = dayjs().subtract(4, 'day').format('YYYY-MM-DD')
  const before = db.call('queryTodos', { deleted: 0, keyword: 'maint-r2 badtime' }).length
  const out = await lib.importEvents([{ date: yesterday, start: '9:xx', end: '10:00', title: 'maint-r2 badtime 甲' }])
  assert.equal(out.failed.length, 1, 'malformed time must land in failed (was created with NaN times)')
  assert.match(out.failed[0].error, /bad start time/)
  const after = db.call('queryTodos', { deleted: 0, keyword: 'maint-r2 badtime' }).length
  assert.equal(after, before, 'no task was created for a malformed start')
})

test('cli-5: importEvents puts an out-of-range end (25:99) into failed; 24:00 end still imports', async () => {
  const yesterday = dayjs().subtract(5, 'day').format('YYYY-MM-DD')
  const bad = await lib.importEvents([{ date: yesterday, start: '09:00', end: '25:99', title: 'maint-r2 badtime 乙' }])
  assert.equal(bad.failed.length, 1)
  assert.match(bad.failed[0].error, /bad end time/)
  const good = await lib.importEvents([{ date: yesterday, start: '21:00', end: '24:00', title: 'maint-r2 badtime 丙 (sentinel ok)' }])
  assert.equal(good.failed.length, 0, 'the 24:00 end-of-day sentinel stays valid')
  assert.equal(good.created, 1)
})

/* ================= cli-6: hasRecord materialized boolean ================= */
test('cli-6: importEvents result.hasRecord is a materialized boolean, JSON-serializable', async () => {
  const yesterday = dayjs().subtract(6, 'day').format('YYYY-MM-DD')
  const res = await lib.importEvents([{ date: yesterday, start: '10:00', end: '11:00', title: 'maint-r2 hasrec 唯一', estimate: 1 }])
  assert.equal(res.created, 1)
  assert.equal(res.failed.length, 0)
  assert.equal(typeof res.hasRecord, 'boolean', 'hasRecord must be a boolean (was a closure function on the result)')
  assert.equal(res.hasRecord, true, 'the past-event import backfilled a manual focus row')
  // the actual consumer contract: the result must survive JSON serialization with the field intact
  const parsed = JSON.parse(JSON.stringify(res))
  assert.equal(parsed.hasRecord, true, 'was silently DROPPED by JSON.stringify when it was a function')
})

/* ================= cli-4: purgeRecycleBin rows-first ================= */
test('cli-4: by the time attachment files are unlinked, the recycle-bin rows are ALREADY purged', () => {
  const t = lib.addTodo({ content: 'maint-r2 purge order probe' })
  lib.deleteTodo(t.taskId)
  assert.equal(lib.recycleTasks().length >= 1, true, 'task is in the recycle bin')
  const filesDir = path.join(userDirMod.userDataDir(), 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const fileName = `${t.taskId}_1700000000000_note.png`
  fs.writeFileSync(path.join(filesDir, fileName), 'x')
  // spy on unlinkSync: record the recycle-bin length at the moment the first file dies.
  // Old order (files-first): rows still present → >=1. New order (rows-first): 0.
  const fsMod = require_('fs')
  const origUnlink = fsMod.unlinkSync
  let binLenAtFirstUnlink = null
  fsMod.unlinkSync = (p, ...rest) => {
    if (binLenAtFirstUnlink === null && path.basename(String(p)) === fileName) {
      binLenAtFirstUnlink = db.call('queryTodos', { deleted: 1 }).length
    }
    return origUnlink.call(fsMod, p, ...rest)
  }
  try {
    lib.purgeRecycleBin()
  } finally {
    fsMod.unlinkSync = origUnlink
  }
  assert.equal(fs.existsSync(path.join(filesDir, fileName)), false, 'attachment file is removed by the purge')
  assert.equal(lib.recycleTasks().filter(r => r.taskId === t.taskId).length, 0, 'row is purged')
  assert.notEqual(binLenAtFirstUnlink, null, 'the purge actually went through the file pass')
  assert.equal(binLenAtFirstUnlink, 0, 'rows must be purged BEFORE the irreversible file deletion (files-first left live rows whose files were already gone)')
})

/* ================= cli-3: env-clean --all opt-in for pickdone-backups ================= */
test('cli-3: collectTargets includes pickdone-backups ONLY with all=true; cleanEnv honors it', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-r2-approot-'))
  try {
    fs.mkdirSync(path.join(appRoot, 'pickdone-backups'), { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'pickdone-backups', 'auto-2026-01-01.db'), 'backup bytes')
    fs.mkdirSync(path.join(appRoot, '.dev-data'), { recursive: true })
    fs.mkdirSync(path.join(appRoot, 'tests', '.artifacts'), { recursive: true })

    const withoutAll = envClean.collectTargets({ all: false, appRoot })
    assert.equal(withoutAll.filter(t => t.p.includes('pickdone-backups')).length, 0,
      'pickdone-backups must NOT be collected without opt-in (was always collected — a bare clean could delete possibly-real backups)')
    assert.equal(withoutAll.some(t => t.p.includes('.dev-data')), true, '.dev-data stays a default target')

    const withAll = envClean.collectTargets({ all: true, appRoot })
    assert.equal(withAll.filter(t => t.p.includes('pickdone-backups')).length, 1, '--all opts pickdone-backups in (the previously dead flag now does exactly this)')

    // end to end: cleanEnv without all leaves the dir, with all removes it
    const keep = envClean.cleanEnv({ all: false, dry: false, appRoot })
    assert.equal(keep.list.some(i => i.path.includes('pickdone-backups')), false)
    assert.equal(fs.existsSync(path.join(appRoot, 'pickdone-backups')), true, 'bare clean leaves pickdone-backups alone')
    envClean.cleanEnv({ all: true, dry: false, appRoot })
    assert.equal(fs.existsSync(path.join(appRoot, 'pickdone-backups')), false, '--all clean removes the opted-in leak dir')
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})

/* ================= cli-7: deterministic packaged exe picker ================= */
test('cli-7: pickProductExe prefers the product name and skips installer utilities deterministically', () => {
  const pick = libEnv.pickProductExe
  // raw readdir order (NTFS ≈ creation order) used to decide: uninstaller could win
  assert.equal(pick(['Uninstall PickDone.exe', 'crashpad_handler.exe', 'PickDone.exe'], ['PickDone']), 'PickDone.exe')
  assert.equal(pick(['zeta.exe', 'alpha.exe', 'setup.exe', 'uninstaller.exe'], ['NoNameMatch']), 'alpha.exe',
    'fallback = first NON-utility exe in sorted order (readdir order used to decide)')
  assert.equal(pick(['uninstall.exe', 'setup.exe'], []), null, 'only utility exes → not found instead of launching the uninstaller')
  assert.equal(pick([], []), null)
  // determinism: same set, any input order → same answer
  const a = pick(['b-app.exe', 'a-app.exe', 'Uninstall.exe'], [])
  const b = pick(['Uninstall.exe', 'a-app.exe', 'b-app.exe'], [])
  assert.equal(a, b)
  assert.equal(a, 'a-app.exe')
})

/* ================= cli-15: sync pair fails fast on null / !ok codeAck ================= */
function fakeSyncLib ({ acks }) {
  const writes = []
  return {
    writes,
    lib: {
      CliError: lib.CliError,
      writeSyncCmd: cmd => { writes.push(cmd); return writes.length },
      waitForSyncAck: async () => acks.shift(),
      open: () => ({ call: () => null })
    }
  }
}
test('cli-15: sync pair with NO pairing-code ack throws APP_NOT_RUNNING and never writes the pair command', async () => {
  const f = fakeSyncLib({ acks: [null] })
  await assert.rejects(() => runSync({ opts: { _: ['pair'], host: '10.0.0.9' }, lib: f.lib, emit: () => {} }),
    e => e.code === 'APP_NOT_RUNNING')
  assert.deepEqual(f.writes.map(w => w.action), ['pairing-code'], 'the pair leg must not be attempted after the failed first leg (was silent fall-through)')
})
test('cli-15: sync pair with a !ok pairing-code ack throws SYNC_ERROR carrying the ack error', async () => {
  const f = fakeSyncLib({ acks: [{ ok: false, error: 'coderequest denied' }] })
  await assert.rejects(() => runSync({ opts: { _: ['pair'], host: '10.0.0.9' }, lib: f.lib, emit: () => {} }),
    e => e.code === 'SYNC_ERROR' && /coderequest denied/.test(e.message))
  assert.deepEqual(f.writes.map(w => w.action), ['pairing-code'])
})
test('cli-15: sync pair still proceeds (prints own code) when the pairing-code ack is ok', async () => {
  const f = fakeSyncLib({
    acks: [
      { ok: true, code: { code: '123456' } },
      { ok: true, status: { peers: [] } }
    ]
  })
  const out = []
  await runSync({ opts: { _: ['pair'], host: '10.0.0.9', json: true }, lib: f.lib, emit: d => out.push(d) })
  assert.deepEqual(f.writes.map(w => w.action), ['pairing-code', 'pair'], 'the happy path still runs both legs')
  assert.deepEqual(out[0], { paired: true, host: '10.0.0.9', port: null, status: { peers: [] } })
})

/* ================= subprocess round: cli-2 (clean gate + --yes) and cli-16 (deps rm) ================= */
const isolEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-r2-proc-'))
  return {
    env: { ...process.env, TODO_DB_DIR: path.join(dir, 'db'), TODO_USER_DATA_DIR: path.join(dir, 'ud') },
    dir
  }
}
const runCli = (args, env) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

test('cli-2: bare `clean` needs --yes (NEEDS_CONFIRM), --dry-run previews, and `clean` is isolation-gated', async () => {
  const { env, dir } = isolEnv()
  try {
    const bare = await runCli(['clean', '--json'], env)
    assert.equal(bare.code, 1)
    assert.match(bare.stderr, /NEEDS_CONFIRM/, 'the destructive pass must require explicit --yes (used to delete immediately)')

    const dry = await runCli(['clean', '--dry-run', '--json'], env)
    assert.equal(dry.code, 0, '--dry-run previews without --yes')
    const dryData = JSON.parse(dry.stdout)
    assert.equal(dryData.ok, true)
    assert.ok(Array.isArray(dryData.data.list), 'dry-run returns the target list without deleting')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cli-2: `clean` joins the isolation gate (no isolation env → ISOLATION_REQUIRED)', async () => {
  const env = { ...process.env }
  delete env.TODO_DB_DIR
  delete env.TODO_USER_DATA_DIR
  env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-r2-fakeappdata-'))
  try {
    const r = await runCli(['clean', '--yes', '--json'], env)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /ISOLATION_REQUIRED/, 'clean must be gated like every other write command (used to run ungated)')
  } finally {
    fs.rmSync(env.APPDATA, { recursive: true, force: true })
  }
})

test('cli-16: deps rm of a NON-predecessor exits non-zero with NOT_A_PREDECESSOR and writes nothing', async () => {
  const { env, dir } = isolEnv()
  try {
    const a = await runCli(['add', 'maint-r2 deps target 甲', '--json'], env)
    assert.equal(a.code, 0)
    const b = await runCli(['add', 'maint-r2 deps stranger 乙', '--json'], env)
    assert.equal(b.code, 0)
    const ta = JSON.parse(a.stdout).data
    const tb = JSON.parse(b.stdout).data
    const before = await runCli(['deps', String(ta.taskId), 'list', '--json'], env)
    const beforeList = JSON.parse(before.stdout).data.predecessors

    const rm = await runCli(['deps', String(ta.taskId), 'rm', String(tb.taskId), '--json'], env)
    assert.equal(rm.code, 1)
    assert.match(rm.stderr, /NOT_A_PREDECESSOR/, 'rm of a non-predecessor must fail loudly (used to write a no-op patch + deps-rm audit row)')

    const after = await runCli(['deps', String(ta.taskId), 'list', '--json'], env)
    assert.deepEqual(JSON.parse(after.stdout).data.predecessors, beforeList, 'predecessor list unchanged')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cli-16: deps rm of an ACTUAL predecessor still works', async () => {
  const { env, dir } = isolEnv()
  try {
    const a = await runCli(['add', 'maint-r2 deps happy 甲', '--json'], env)
    const b = await runCli(['add', 'maint-r2 deps happy 乙', '--json'], env)
    const ta = JSON.parse(a.stdout).data
    const tb = JSON.parse(b.stdout).data
    assert.equal((await runCli(['deps', String(ta.taskId), 'add', String(tb.taskId), '--json'], env)).code, 0)
    const rm = await runCli(['deps', String(ta.taskId), 'rm', String(tb.taskId), '--json'], env)
    assert.equal(rm.code, 0, 'rm of a real predecessor succeeds')
    const list = JSON.parse((await runCli(['deps', String(ta.taskId), 'list', '--json'], env)).stdout)
    assert.equal(list.data.predecessors.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
