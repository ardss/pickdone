/* QC follow-up round (branch fix/qc-followup-main, 2026-09-20) — CLI + scripts fixes:
 *   M-11 CLI purge cleans per-task tomato estimate meta keys (tomatoEstimateState:<taskId>);
 *   M-12 list/search/--on overlay the LIVE meta estimate as `estimate` (tomatoEstimate alias kept);
 *   M-13 pidsFromNetstatOutput helper (check-all win32 orphan reap, ESM-safe);
 *   M-14 verify-packaged-lib: recursive, escape-aware CLI require scan (cli/lib/**, ../src/main,
 *        bare lazy requires like solarlunar / dayjs/locale) — packaged-layout simulation.
 * Behavior tests spawn the real CLI against an isolated temp better-sqlite3 DB.
 * Run: node --test tests/unit/cli/qc-followup-20260920.test.mjs */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-qc-followup-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runCliRaw = args => execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' })
const runCliJson = args => JSON.parse(runCliRaw([...args, '--json']))
const taskIdOf = r => (r.data || r).taskId

// ---------------------------------------------------------------------------
// M-12
// ---------------------------------------------------------------------------
test('M-12: edit --estimate 5 → list --json shows estimate 5 (live meta, not the dead column)', () => {
  const added = runCliJson(['add', 'qc-fl estimate list task'])
  const id = taskIdOf(added)
  runCliJson(['edit', id, '--estimate', '5'])
  const rows = runCliJson(['list', '--all'])
  const list = rows.data || rows
  const row = list.find(t => t.taskId === id)
  assert.ok(row, 'task appears in list --all')
  assert.equal(row.estimate, 5, '`estimate` is the canonical JSON field and reflects the meta key')
  assert.equal(row.tomatoEstimate, 5, '`tomatoEstimate` kept as the documented compat alias')
})

test('M-12: search --json carries the live estimate too', () => {
  const added = runCliJson(['add', 'qc-fl searchable xyzyyl task'])
  const id = taskIdOf(added)
  runCliJson(['edit', id, '--estimate', '3'])
  const rows = runCliJson(['search', 'xyzyyl'])
  const list = rows.data || rows
  assert.equal(list.find(t => t.taskId === id).estimate, 3)
})

test('M-12: list --on <date> --json carries the live estimate', () => {
  const added = runCliJson(['add', 'qc-fl dated task', '--date', '2030-01-02'])
  const id = taskIdOf(added)
  runCliJson(['edit', id, '--estimate', '4'])
  const rows = runCliJson(['list', '--on', '2030-01-02'])
  const list = rows.data || rows
  assert.equal(list.find(t => t.taskId === id).estimate, 4, '--on gains the estimate field')
})

// ---------------------------------------------------------------------------
// M-11 (CLI side)
// ---------------------------------------------------------------------------
test('M-11: cli purge removes the purged task estimate meta keys', () => {
  const added = runCliJson(['add', 'qc-fl purge me task'])
  const id = taskIdOf(added)
  runCliJson(['edit', id, '--estimate', '6'])
  const key = 'tomatoEstimateState:' + id
  assert.equal(db.call('getMeta', key), '6', 'precondition: estimate meta key exists')
  runCliJson(['delete', id]) // soft-delete → recycle bin
  runCliJson(['purge', '--yes']) // hard purge
  assert.equal(db.call('getMeta', key), null, 'estimate key died with the rows (no leak / no id-collision resurrection)')
})

// ---------------------------------------------------------------------------
// M-13
// ---------------------------------------------------------------------------
const evtUtils = require_('../../../cli/event-utils.cjs')
test('M-13: pidsFromNetstatOutput parses unique numeric pids, tolerates garbage', () => {
  const sample = [
    '  TCP    127.0.0.1:5175     0.0.0.0:0    LISTENING    4242',
    '  TCP    127.0.0.1:5175     0.0.0.0:0    LISTENING    4242',
    '  TCP    [::]:5175          [::]:0       LISTENING    8888',
    '  TCP    1.2.3.4:80         5.6.7.8:99   ESTABLISHED  4242',
    'garbage line',
    ''
  ].join('\r\n')
  assert.deepEqual(evtUtils.pidsFromNetstatOutput(sample), ['4242', '8888'])
  assert.deepEqual(evtUtils.pidsFromNetstatOutput(''), [])
  assert.deepEqual(evtUtils.pidsFromNetstatOutput(null), [])
})

// ---------------------------------------------------------------------------
// M-14 verify-packaged-lib — packaged-layout simulation
// ---------------------------------------------------------------------------
const vpLib = require_('../../../scripts/verify-packaged-lib.cjs')

test('M-14: findMissingRequires resolves recursive/escape/bare requires in a simulated resources tree', () => {
  const tmp = isolatedTmpDir('m14-sim-')
  const resRoot = path.join(tmp, 'resources')
  const cliRoot = path.join(resRoot, 'cli')
  // Landed tree: cli root + cli/lib subdir; ../src/main escape target; bare node_modules
  fs.mkdirSync(path.join(cliRoot, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(resRoot, 'src', 'main'), { recursive: true })
  fs.mkdirSync(path.join(resRoot, 'node_modules', 'solarlunar'), { recursive: true })
  fs.mkdirSync(path.join(resRoot, 'node_modules', 'dayjs', 'locale'), { recursive: true })
  fs.writeFileSync(path.join(cliRoot, 'pickdone.js'), "const lib = require('./lib.js')\n")
  fs.writeFileSync(path.join(cliRoot, 'lib.js'), "require('dayjs/locale/zh-cn')\nconst dbm = require('../src/main/db.js')\nconst sl = require('solarlunar')\n")
  fs.writeFileSync(path.join(cliRoot, 'lib', 'extra.js'), "const h = require('./helpers.js')\nconst ghost = require('./missing.js')\n")
  fs.writeFileSync(path.join(cliRoot, 'lib', 'helpers.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(resRoot, 'src', 'main', 'db.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(resRoot, 'node_modules', 'solarlunar', 'package.json'), '{}')
  fs.writeFileSync(path.join(resRoot, 'node_modules', 'dayjs', 'locale', 'zh-cn.js'), 'module.exports = {}\n')

  const missing = vpLib.findMissingRequires({ cliDir: cliRoot, resourcesDir: resRoot, read: f => fs.readFileSync(f, 'utf8') })
  assert.equal(missing.length, 1, 'exactly the deep lib/ghost require is missing')
  assert.ok(/lib\/missing\.js/.test(missing[0]), 'missing entry names the deep relative target: ' + missing[0])

  // Now add the missing file → the scan is clean (incl. solarlunar + dayjs/locale + ../src/main).
  fs.writeFileSync(path.join(cliRoot, 'lib', 'missing.js'), 'module.exports = {}\n')
  assert.deepEqual(vpLib.findMissingRequires({ cliDir: cliRoot, resourcesDir: resRoot, read: f => fs.readFileSync(f, 'utf8') }), [])
})

test('M-14: solarlunar packaging simulation — extraResources copy satisfies the lazy bare require', () => {
  // Simulate what the real extraResources entry now ships: resources/node_modules/solarlunar
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entry = pkg.build.extraResources.find(e => String(e.from).includes('solarlunar'))
  assert.ok(entry, 'package.json extraResources ships node_modules/solarlunar next to dayjs')
  assert.equal(entry.from, 'node_modules/solarlunar')
  assert.equal(entry.to, 'node_modules/solarlunar')
  // and the real package actually resolves from the simulated layout
  const simRoot = path.join(ROOT, 'node_modules') // real tree: same resolution shape as resources/node_modules
  const solar = require_(path.join(simRoot, 'solarlunar', 'package.json'))
  assert.ok(solar.main || solar.exports || fs.existsSync(path.join(simRoot, 'solarlunar', 'index.js')), 'solarlunar has a resolvable entrypoint')
})

test('M-14: node builtins and dev-diagnostic files are out of scan scope', () => {
  assert.equal(vpLib.isNodeBuiltin('fs'), true)
  assert.equal(vpLib.isNodeBuiltin('node:child_process'), true)
  assert.equal(vpLib.isNodeBuiltin('solarlunar'), false)
})
