#!/usr/bin/env node
/**
 * CLI smoke test — the whole flow runs against a temporary isolated DB, never touching real data
 * Usage: node cli/cli-smoke.js
 * Mandatory after any semantic change; any assertion failure exits non-zero
 */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'cli', 'pickdone.js')
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-smoke-'))
process.env.TODO_DB_DIR = dbDir

let passed = 0
function run (args) {
  if (!args.includes('--json')) args = [...args, '--json']
  const out = execFileSync(process.execPath, [CLI, ...args], {
    env: process.env, encoding: 'utf8'
  })
  return JSON.parse(out)
}
function ok (name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); process.exitCode = 1 }
}

async function mainBody () {
  try {
  console.log('[1] add / list')
  const a = run(['add', '冒烟A', '--date', 'tomorrow'])
  ok('add returns taskId', !!a.data.taskId)
  run(['add', '冒烟B'])
  const list = run(['list', '--all'])
  ok('list has 2 rows', list.data.length === 2, 'got ' + list.data.length)

  console.log('[2] subtask cascade')
  const lib = require(path.join(ROOT, 'cli/lib.js'))
  lib.open()
  const db = require(path.join(ROOT, 'src/main/db.js'))
  const t1 = run(['get', '冒烟A'])
  // T1-3: one unchecked + one checked — avoids the "all checked" false positive
  db.call('upsert', { ...t1.data, subtasks: JSON.stringify([{ text: '子1', checked: false }, { text: '子2', checked: true }]) })
  const d = run(['done', '冒烟A'])
  const subs = JSON.parse(d.data.subtasks || '[]')
  ok('subtask cascade checks the unchecked one', subs[0] && subs[0].checked === true)
  ok('already-checked subtask stays checked', subs[1] && subs[1].checked === true)
  ok('completedAt written', d.data.completedAt > 0)

  console.log('[3] undo / edit / delete / restore')
  const u = run(['undo', '冒烟A'])
  ok('undo resets completedAt', u.data.completedAt === 0 && u.data.complete === false)
  const e = run(['edit', '冒烟B', '--content', '冒烟B改', '--date', '+3d'])
  ok('edit applied', e.data.taskContent === '冒烟B改' && e.data.dayStart > 0)
  const del = run(['delete', '冒烟B改'])
  ok('soft delete', del.data.delete === true && del.data.status === 'delete')
  const res = run(['restore', '冒烟B改'])
  ok('restore', res.data.delete === false)

  console.log('[4] repeat-group renewal')
  const rid = 'repeat_smoke'
  const dayjs = require('dayjs')
  const seed = (off, done) => {
    const b = run(['add', '刷牙', '--date', dayjs().add(off, 'day').format('YYYY-MM-DD')])
    db.call('upsert', { ...b.data, repeatId: rid, complete: done, completedAt: done ? Date.now() : 0, status: done ? 'update' : 'add' })
    return b.data
  }
  // T1-1: renewal latest-instance decision — completing the early one does not renew; only completing the late one renews
  const early = seed(0, false)
  const late = seed(1, false)
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ repeatType: 'day', repeatInterval: 1 })])
  const rEarly = run(['done', early.taskId])
  ok('completing a non-latest instance does not renew', rEarly.renewed === null)
  const rLate = run(['done', late.taskId])
  ok('renewal generates a new instance (latest one completed)', !!rLate.renewed)
  ok('new instance is in the same group and incomplete', rLate.renewed && rLate.renewed.repeatId === rid && rLate.renewed.complete === false)

  console.log('[5] error protocol')
  try { run(['done', '冒烟A 冒烟B 不存在的东西']) ; ok('TASK_NOT_FOUND should throw', false) }
  catch (err) {
    const e2 = JSON.parse(String(err.stderr))
    ok('TASK_NOT_FOUND structured output', e2.error === 'TASK_NOT_FOUND')
  }
  try { run(['purge']) ; ok('purge without --yes should be rejected', false) }
  catch (err) {
    const e3 = JSON.parse(String(err.stderr))
    ok('NEEDS_CONFIRM structured output', e3.error === 'NEEDS_CONFIRM')
  }

  console.log('[6] ambiguous matching')
  run(['add', '多义X']); run(['add', '多义Y'])
  try { run(['done', '多义']) ; ok('AMBIGUOUS_MATCH should throw', false) }
  catch (err) {
    const e4 = JSON.parse(String(err.stderr))
    ok('AMBIGUOUS_MATCH lists candidates', e4.error === 'AMBIGUOUS_MATCH' && e4.message.includes('多义X'))
  }

  console.log('[7] dual-source parity (render vs core expandRepeatDates line-by-line equivalence)')
  // M1-2: turned the high-risk "line-by-line equivalent" comment into an automated assertion — any "fixed one side, forgot the other" alarms immediately
  // The ok of the awaited dynamic import counts too (the script body awaits once at the top so [7] is counted in passed)
  await (async () => {
    const core = require(path.join(ROOT, 'src/main/core/todo-core.js'))
    globalThis.window = { dayjs: (await import('dayjs')).default, pinyinPro: require('pinyin-pro') } // repeat.js → core.js reads window.dayjs/pinyinPro at module top level; the stub must be in place before import
    const { pathToFileURL } = require('url')
    const r = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/repeat.js')).href)
    const rule = { repeatType: 'day', repeatInterval: 1, repeatDayCount: 5 }
    const base = +globalThis.window.dayjs('2026-08-28')
    const rOut = r.expandRepeatDates(base, rule, []).map(d => d.format('YYYY-MM-DD'))
    const cOut = core.expandRepeatDates(base, rule, []).map(d => d.format('YYYY-MM-DD'))
    ok('render and core outputs equal day by day', JSON.stringify(rOut) === JSON.stringify(cOut),
       `render=${rOut.join(',')}\ncore=${cOut.join(',')}`)
  })()

  console.log(`\n== all ${passed} checks passed ==`)
  } finally {
    // Cleanup is purely best-effort: on CI child-process handles may be released later than process exit; failure after retries does not affect the exit code
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dbDir, { recursive: true, force: true }); break } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300) }
    }
  }
}
mainBody().catch(e => { console.error('smoke failed:', e.message); process.exit(1) })
