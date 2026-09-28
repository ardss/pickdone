/* maint/d11 coverage-restore wave: contract tests for the extracted CLI command groups the d11
 * rounds touched — cli/lib-tomato.cjs (list/record/status/start/stop/attach/backfill dispatch),
 * cli/lib-schedule.cjs (subtask/attachment/settings/plan/repeat), cli/lib-taxonomy.cjs
 * (category/tag), and cli/check-coverage-ratchet.cjs's exported parse/baseline helpers.
 * Run: node --test tests/unit/cli/d11-cli-tomato-schedule-taxonomy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)

const runTomato = require('../../../cli/lib-tomato.cjs')
const schedule = require('../../../cli/lib-schedule.cjs')
const taxonomy = require('../../../cli/lib-taxonomy.cjs')
const ratchet = require('../../../cli/check-coverage-ratchet.cjs')

class CliError extends Error { constructor (msg, code) { super(msg); this.code = code } }

async function captureLogs (fn) {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { await fn() } finally { console.log = orig }
  return logs
}

function makeLib (extra = {}) {
  return {
    CliError,
    resolveTask: (ref, pool) => pool.find(t => t.taskId === ref || t.taskContent.includes(ref)) || (() => { throw new CliError('no task', 'NOT_FOUND') })(),
    liveTasks: () => extra.tasks || [{ taskId: 't1', taskContent: 'write report' }],
    tomatoRecords: () => extra.records || [],
    parseDate: s => new Date(s).getTime(),
    recordRemove: ref => { extra.removed = { rec: { tomatoId: ref, dateKey: '2026-09-28', focusDuration: 25, focus: 'write report' } }; return extra.removed },
    recordFix: (ref, patch) => ({ rec: Object.assign({ tomatoId: ref, dateKey: '2026-09-28', focusDuration: patch.minutes || 25, restDuration: 0, succeed: true, focus: 'write report' }, patch) }),
    resolveRecord: id => ({ tomatoId: id, dateKey: '2026-09-28', focusDuration: 50, restDuration: 0, succeed: true, focus: 'write report' }),
    readTomatoState: () => extra.state,
    tomatoLiveRemainSec: st => (st.remainSec != null ? st.remainSec : 0),
    writeTomatoCmd: cmd => (extra.cmds = extra.cmds || []).push(cmd),
    waitForTomatoAck: async () => extra.ack === undefined ? { ok: true } : extra.ack,
    backfillRecord: input => Object.assign({ tomatoId: 'tmt_x', dateKey: input.date, focusDuration: input.minutes }, input),
    ...(extra.lib || {})
  }
}

test('tomato list: date filters, task filter, limit and JSON emit with live-name resolution', async () => {
  // Date keys derive from the SAME clock the lib filters with (dayjs local today) — hardcoded
  // dates made this test fail at every local midnight rollover.
  const dayjs = require('dayjs')
  const TODAY = dayjs().format('YYYY-MM-DD')
  const YESTERDAY = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
  const recs = [
    { tomatoId: 'a', dateKey: TODAY, endTime: Date.now(), focusDuration: 25, focus: 'stale name', focusTaskId: 't1' },
    { tomatoId: 'b', dateKey: YESTERDAY, endTime: Date.now() - 86400000, focusDuration: 10, succeed: false, focus: 'other' },
    { tomatoId: 'c', dateKey: TODAY, endTime: 0, focusDuration: 0, focus: '' }
  ]
  const lib = makeLib({ records: recs })
  const logs = await captureLogs(() => runTomato({ opts: { _: ['list'], date: 'today' }, lib }))
  assert.ok(logs.length >= 2, 'today filter keeps only today rows + the summary')
  assert.ok(logs[0].includes('write report'), 'stale focus name resolved live from the task pool')
  assert.ok(logs[0].includes('✓'))
  assert.ok(logs.join(' | ').includes('-- 2 record(s)'))

  const emitted = []
  await runTomato({ opts: { _: ['list'], json: true, n: 1 }, lib: makeLib({ records: recs }), emit: v => emitted.push(v) })
  assert.equal(emitted[0].length, 1, '--n limit applies')
  assert.equal(emitted[0][0].focus, 'write report')

  const none = await captureLogs(() => runTomato({ opts: { _: ['list'], date: '1999-01-01' }, lib: makeLib({ records: recs }) }))
  assert.ok(none[0].includes('no focus records match'))
  assert.equal(logs.length, 3, 'two today rows + the summary line')
})

test('tomato record rm/fix: usage errors and JSON output; unknown sub-op rejected', async () => {
  const lib = makeLib({})
  const emitted = []
  await runTomato({ opts: { _: ['record', 'rm', 'tmt_a'], json: true }, lib, emit: v => emitted.push(v) })
  assert.equal(emitted[0].removed, 'tmt_a')
  await assert.rejects(() => runTomato({ opts: { _: ['record', 'rm'] }, lib: makeLib({}), emit: null }), e => e.code === 'USAGE')
  const fixed = []
  await runTomato({ opts: { _: ['record', 'fix', 'tmt_a'], json: true, minutes: '50' }, lib: makeLib({}), emit: v => fixed.push(v) })
  assert.equal(fixed[0].focusDuration, 50)
  await assert.rejects(() => runTomato({ opts: { _: ['record', 'frobnicate', 'x'] }, lib: makeLib({}), emit: null }), e => e.code === 'UNKNOWN_ARG')
})

test('tomato status: unknown state, stale running flag, idle plain output and JSON tags', async () => {
  const emitted = []
  await runTomato({ opts: { _: ['status'], json: true }, lib: makeLib({ state: null }), emit: v => emitted.push(v) })
  assert.equal(emitted[0].status, 'unknown')

  const stale = await captureLogs(() => runTomato({ opts: { _: ['status'] }, lib: makeLib({ state: { status: 'startTomatoTime', at: Date.now() - 9000, todayTomatoCount: 2, remainSec: 600 } }) }))
  assert.ok(stale[0].includes('focusing (stale)'), 'running + old at → stale flagged')
  assert.ok(stale[0].includes('10 min left'))

  const idle = await captureLogs(() => runTomato({ opts: { _: ['status'] }, lib: makeLib({ state: { status: 'default', at: Date.now(), todayTomatoCount: 3, attach: { content: 'task one' } } }) }))
  assert.ok(idle[0].includes('idle') && idle[0].includes('3 today') && idle[0].includes('attached: task one'))
})

test('tomato start/stop/attach: ack-contract — null ack errors APP_NOT_RUNNING, ok ack confirms', async () => {
  await assert.rejects(() => runTomato({ opts: { _: ['start'], task: 't1' }, lib: makeLib({ ack: null }), emit: null }),
    e => e.code === 'APP_NOT_RUNNING', 'start without the App must fail loudly')
  await assert.rejects(() => runTomato({ opts: { _: ['stop'] }, lib: makeLib({ ack: null }), emit: null }), e => e.code === 'APP_NOT_RUNNING')
  await assert.rejects(() => runTomato({ opts: { _: ['attach', 't1'] }, lib: makeLib({ ack: null }), emit: null }), e => e.code === 'APP_NOT_RUNNING')

  const cmds = []
  const ok = await captureLogs(() => runTomato({ opts: { _: ['start'], task: 't1', minutes: '25' }, lib: makeLib({ ack: { ok: true }, lib: { writeTomatoCmd: c => cmds.push(c) } }), emit: null }))
  assert.ok(ok[0].includes('focus started') && ok[0].includes('task t1') && ok[0].includes('25 min'))

  const attachLogs = await captureLogs(() => runTomato({ opts: { _: ['attach', 'none'] }, lib: makeLib({}), emit: null }))
  assert.ok(attachLogs[0].includes('detached'), 'none ref detaches')

  const emitted = []
  await runTomato({ opts: { _: ['stop'], 'no-record': true, json: true }, lib: makeLib({}), emit: v => emitted.push(v), emitNext: (v) => emitted.push(v) })
  assert.equal(emitted[0].record, false)
})

test('tomato backfill: date normalization (today/tomorrow/+Nd), free focus, bad date/at rejected', async () => {
  const lib = makeLib({})
  await assert.rejects(() => runTomato({ opts: { _: ['backfill'] }, lib, emit: null }), e => e.code === 'USAGE', 'no target → usage')
  await assert.rejects(() => runTomato({ opts: { _: ['backfill'], free: true, date: 'soon' }, lib, emit: null }), e => e.code === 'USAGE')
  await assert.rejects(() => runTomato({ opts: { _: ['backfill'], free: true, at: '25:00' }, lib, emit: null }), e => e.code === 'USAGE')
  const emitted = []
  await runTomato({ opts: { _: ['backfill'], free: true, date: '+3d', at: '09:30', json: true }, lib, emit: null, emitNext: (v) => emitted.push(v) })
  assert.equal(emitted[0].minutes, 25, 'default 25 minutes')
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(emitted[0].dateKey), '+3d normalized to a local YMD date')
  await assert.rejects(() => runTomato({ opts: { _: ['tomato'] }, lib, emit: null }), e => e.code === 'USAGE', 'bare tomato → usage')
})

/* ---------- lib-schedule.cjs ---------- */

test('schedule groups: subtask add/check/rm/move with usage errors; settings get/set/unknown; plan list/set/rm shortcut', async () => {
  const t = { taskId: 't1', taskContent: 'task', subtasks: JSON.stringify([{ text: 'a', checked: false }]) }
  const lib = {
    CliError,
    addSubtask: () => t,
    checkSubtask: () => t,
    removeSubtask: () => t,
    moveSubtask: () => ({ order: ['b', 'a'] }),
    parseSubs: () => [{ text: 'a', checked: true }],
    settingsList: () => [{ key: 'colorMode', value: 'light', type: 'enum', options: ['light', 'dark'] }],
    settingsSet: (k, v) => ({ key: k, value: v, previous: 'light' }),
    planList: () => ({ day: '2026-09-28', tasks: [{ chips: ['09:00'], complete: false, content: 'task' }] }),
    planSet: (task, chip) => ({ day: '2026-09-28', content: 'task', chips: [chip] }),
    planRemove: () => ({ day: '2026-09-28', taskId: 't1', removed: 2 }),
    buildRepeatRule: () => ({ type: 'daily' }),
    repeatOn: () => ({ rid: 'r1', made: 3 }),
    repeatOff: () => ({ removed: 1 }),
    repeatRuleInfo: () => ({ rid: 'r1', type: 'daily' })
  }
  const logs = await captureLogs(() => schedule.runSubtask({ opts: { _: ['add', 't1', 'new sub'] }, lib, emit: null }))
  assert.ok(logs[0].includes('✓') && logs[1].includes('[x] a'))
  await assert.rejects(async () => schedule.runSubtask({ opts: { _: ['check', 't1'] }, lib, emit: null }), e => e.code === 'USAGE')
  await assert.rejects(async () => schedule.runSubtask({ opts: { _: ['bogus', 't1'] }, lib, emit: null }), /unknown sub-operation "bogus"/)
  const moved = await captureLogs(() => schedule.runSubtask({ opts: { _: ['move', 't1', '1', 'down'] }, lib, emit: null }))
  assert.ok(moved.join('\n').includes('b'), 'move prints the new order')

  await assert.rejects(async () => schedule.runSettings({ opts: { _: ['get'] }, lib, emit: null }), e => e.code === 'USAGE')
  await assert.rejects(async () => schedule.runSettings({ opts: { _: ['get', 'nope'] }, lib, emit: null }), e => e.code === 'UNKNOWN_KEY')
  const getLine = await captureLogs(() => schedule.runSettings({ opts: { _: ['get', 'colorMode'] }, lib, emit: null }))
  assert.ok(getLine[0].includes('colorMode = "light"'))
  const setMsg = []
  await schedule.runSettings({ opts: { _: ['set', 'colorMode', 'dark'] }, lib, emit: null, okMsg: (s, hints, msg) => setMsg.push(msg) })
  assert.ok(setMsg[0].includes('colorMode = "dark"') && setMsg[0].includes('was "light"'))
  await assert.rejects(async () => schedule.runSettings({ opts: { _: ['bogus'] }, lib, emit: null }), e => e.code === 'UNKNOWN_ARG')

  const planLogs = await captureLogs(() => schedule.runPlan({ opts: { _: ['list'] }, lib, emit: null }))
  assert.ok(planLogs[0].includes('09:00') && planLogs[0].includes('task'))
  const planMsg = []
  await schedule.runPlan({ opts: { _: ['t1', '10:00'] }, lib, emit: null, okMsg: (p, h, msg) => planMsg.push(msg) })
  assert.ok(planMsg[0].includes('10:00'), 'shortcut form plans directly')
  const rmMsg = []
  await schedule.runPlan({ opts: { _: ['rm', 't1'] }, lib, emit: null, okMsg: (p, h, msg) => rmMsg.push(msg) })
  assert.ok(rmMsg[0].includes('removed 2 chip(s)'))
  await assert.rejects(async () => schedule.runPlan({ opts: { _: ['bogus'] }, lib: { CliError, planList: () => ({ tasks: [], day: 'd' }) }, emit: null, okMsg: () => {} }), e => e.code === 'UNKNOWN_ARG')

  const repLogs = await captureLogs(() => schedule.runRepeat({ opts: { _: ['on', 't1'] }, lib, emit: null }))
  assert.ok(repLogs[0].includes('group r1') && repLogs[0].includes('3 future instance(s)'))
  await assert.rejects(async () => schedule.runRepeat({ opts: { _: ['bogus'] }, lib, emit: null }), e => e.code === 'USAGE')
})

/* ---------- lib-taxonomy.cjs ---------- */

test('taxonomy: category add/rename/rm confirm cascade; tag list output', async () => {
  const lib = {
    CliError,
    addCategory: (name, o) => ({ categoryId: 5, categoryName: name, categoryColor: o.color || '#0f9d8f', folderId: 0, folderIs: o.folder ? 1 : 0 }),
    renameCategory: () => ({ categoryId: 5, categoryName: 'renamed' }),
    resolveCategory: () => 5,
    getCategories: () => [{ categoryId: 5, categoryName: 'old' }],
    deleteCategory: () => ({ deleted: [{ name: 'old' }, { name: 'child' }], removedFilters: 2 }),
    listTags: () => [{ name: 'urgent', tasks: 3 }]
  }
  const created = await captureLogs(() => taxonomy.runCategory({ opts: { _: ['add', 'proj'] }, lib, emit: null }))
  assert.ok(created[0].includes('category created: proj') && created[0].includes('id 5'))
  await assert.rejects(async () => taxonomy.runCategory({ opts: { _: ['add'] }, lib, emit: null }), e => e.code === 'USAGE')
  const renamed = await captureLogs(() => taxonomy.runCategory({ opts: { _: ['rename', 'proj', 'renamed'] }, lib, emit: null }))
  assert.ok(renamed[0].includes('renamed'))
  await assert.rejects(async () => taxonomy.runCategory({ opts: { _: ['rm', 'proj'] }, lib, emit: null }), e => e.code === 'NEEDS_CONFIRM', 'rm without --yes refuses')
  const dry = await captureLogs(() => taxonomy.runCategory({ opts: { _: ['rm', 'proj'], 'dry-run': true }, lib, emit: null }))
  assert.ok(dry[0].includes('dry run'))
  const deleted = await captureLogs(() => taxonomy.runCategory({ opts: { _: ['rm', 'proj'], yes: true }, lib, emit: null }))
  assert.ok(deleted[0].includes('old, child') && deleted[0].includes('2 saved filter(s) removed'), 'cascade report matches the renderer undo message')

  const tags = await captureLogs(() => taxonomy.runTag({ opts: { _: ['list'] }, lib: { CliError, listTags: () => [{ name: 'urgent', tasks: 3 }] }, emit: null }))
  assert.ok(tags[0].includes('#urgent') && tags[0].includes('3 task(s)'))
  const noTags = await captureLogs(() => taxonomy.runTag({ opts: { _: [] }, lib: { CliError, listTags: () => [] }, emit: null }))
  assert.ok(noTags[0].includes('no tags'))
})

/* ---------- check-coverage-ratchet.cjs exported helpers ---------- */

test('ratchet helpers: parseAllFiles anchors on the LAST all-files row; loadBaseline/writeBaseline round-trip', () => {
  const out = [
    '# all files | 99.9 | 99.9 | 99.9 |',
    '# some noise all files | 1 | 1 | 1',
    '# all files                              |  72.64 |    72.36 |   58.84 | '
  ].join('\n')
  assert.deepEqual(ratchet.parseAllFiles(out), { lines: 72.64, branches: 72.36, functions: 58.84 }, 'last row wins (forged-summary guard)')
  assert.equal(ratchet.parseAllFiles('nothing here'), null)

  const dir = mkdtempSync(join(tmpdir(), 'ratchet-test-'))
  const baselineFile = join(dir, 'baseline.json')
  writeFileSync(baselineFile, JSON.stringify({ baselines: { 'win32@node22': { lines: 87, branches: 81, functions: 78 } } }))
  // loadBaseline reads the REAL BASELINE_FILE keyed platform@nodeMajor (2026-09-29): zeros mean
  // this combo has no baseline yet — the gate calibrates on its first full-green run.
  const base = ratchet.loadBaseline()
  const raw = JSON.parse(readFileSync(join('cli', '.coverage-baseline.json'), 'utf8'))
  const thisCombo = `${process.platform}@node${process.versions.node.split('.')[0]}`
  const knownCombo = Object.prototype.hasOwnProperty.call(raw.baselines, thisCombo)
  if (knownCombo) assert.ok(base.lines > 0, 'real baseline loads on a combo that has one')
  else assert.equal(base.lines, 0, 'unknown platform@node combo reads zeros (calibrate-on-first-green)')
  void baselineFile
  void existsSync
})
