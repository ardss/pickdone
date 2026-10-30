/* W8 fixer round M8C (stats/CLI domain) — 2026-10-25.
 * Covered findings:
 *   #1 LOW  db-stats-ops._dayBounds accepted non-existent dates (20260231 rolled to March via
 *      new Date carry) and silently drifted the stats range — dayjs round-trip validation now
 *      rejects them with an 'invalid calendar date' error.
 *   #2 LOW-MED cli repeat off single scope deleted an arbitrary hits[0] when a keyword matched
 *      several repeat instances — now AMBIGUOUS_MATCH listing candidates (taskId + date);
 *      unique hits keep the legacy behavior; a day argument disambiguates.
 *   #3 LOW  listTodos truncation sentinel leaked its hint text into `--json` payloads as an
 *      enumerable taskContent pseudo-row — the hint is now a non-enumerable property: JSON
 *      carries { truncated: true } only, the text renderer still reads the hint.
 *   #4 LOW  cli allowed-backup-dirs.json: ENOENT (first run) stays silent; unreadable/corrupt
 *      whitelist now warns (injected logger / stderr) while still falling back to the default
 *      root — aligned with src/main/backup-dirs.js loadAllowedBackupDirs.
 * Run: node --test tests/unit/main/w8-stats-cli.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'
import fs from 'node:fs'
import path from 'node:path'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-w8-stats-cli-')
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')

/* ================= #1 _dayBounds non-existent date round-trip ================= */
const statsOps = require_('../../../src/main/db-stats-ops.js')

test('#1 _dayBounds rejects a non-existent date (20260231) instead of silently drifting into March', () => {
  assert.throws(
    () => statsOps._dayBounds({ from: 20260231, to: 20260301 }),
    e => /invalid calendar date|20260231/.test(e.message),
    'Feb 31 must be a loud invalid-date error (was: new Date carry → Mar 3 range)'
  )
  assert.throws(
    () => statsOps._dayBounds({ from: 20260101, to: 20260431 }),
    e => /invalid calendar date|20260431/.test(e.message),
    'Apr 31 likewise'
  )
})

test('#1 _dayBounds accepts a real date (20260228) with unchanged bounds', () => {
  const [f, t] = statsOps._dayBounds({ from: 20260228, to: 20260228 })
  assert.equal(f, new Date(2026, 1, 28).getTime(), 'from = local Feb 28 midnight')
  assert.equal(t, +dayjs(f).add(1, 'day').startOf('day') - 1, 'to = Feb 28 local day end (DST-safe)')
})

/* ================= shared fakes for the CLI fixes ================= */
class FakeCliError extends Error {
  constructor (message, code = 'CLI_ERROR') { super(message); this.code = code }
}

/* ================= #2 repeat off single-instance disambiguation ================= */
function repeatFactory (rows, { commitSpy } = {}) {
  const core = require_('../../../src/main/core/todo-core.js')
  return require_('../../../cli/lib-repeat.cjs')({
    open: () => ({ call: (op, ...a) => {
      if (op === 'queryTodos') {
        const q = a[0] || {}
        return rows.filter(r => (q.deleted === undefined || (r.delete ? 1 : 0) === q.deleted) &&
          (q.repeatId === undefined || r.repeatId === q.repeatId))
      }
      if (op === 'getMeta') return null
      if (op === 'planAll') return []
      throw new Error('unexpected op ' + op)
    } }),
    commit: (entity, verb, payload) => { if (commitSpy) commitSpy(entity, verb, payload) },
    audit: { record: () => {} },
    CliError: FakeCliError,
    dayjs,
    core,
    resolveTask: input => { throw new FakeCliError('task not found: ' + input, 'TASK_NOT_FOUND') },
    liveTasks: () => rows,
    normKey: s => String(s || '').toLowerCase(),
    settingsDoc: () => ({}),
    chipsSnapshotForDelete: () => {},
    dayStartOf: ts => (ts ? +dayjs(ts).startOf('day') : 0),
    clampEstimate: v => Math.max(0, Math.min(20, v || 0)),
    getEstimateOf: () => 0,
    estimateKey: id => 'tomatoEstimate:' + id
  })
}

const mkRow = (over = {}) => {
  const now = Date.now()
  return {
    complete: false, createTime: now, delete: false, reminderTime: 0, estimate: 0,
    repeatId: null, subtasks: null, categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'w8 dupe task', taskDescribe: '', taskSort: 0, todoTime: 0, dayStart: 0,
    userId: 1, status: 'add', version: 0, taskId: 'w8_' + Math.random().toString(36).slice(2, 8),
    ...over
  }
}

test('#2a repeat off single scope: keyword matching MULTIPLE repeat instances throws AMBIGUOUS_MATCH with candidates + dates', () => {
  const d1 = +dayjs('2026-11-01').startOf('day')
  const d2 = +dayjs('2026-11-02').startOf('day')
  const rows = [
    mkRow({ taskContent: 'w8 dupe task', repeatId: 'repeat_x1', dayStart: d1, todoTime: d1 }),
    mkRow({ taskContent: 'w8 dupe task', repeatId: 'repeat_x1', dayStart: d2, todoTime: d2 })
  ]
  const lib = repeatFactory(rows)
  let err
  try { lib.repeatOff('dupe', false) } catch (e) { err = e }
  assert.ok(err, 'must refuse to pick an arbitrary hits[0]')
  assert.equal(err.code, 'AMBIGUOUS_MATCH')
  for (const r of rows) assert.ok(err.message.includes(r.taskId), 'candidate taskId listed: ' + r.taskId)
  assert.ok(/2026-11-01/.test(err.message) && /2026-11-02/.test(err.message), 'candidate dates listed')
})

test('#2b repeat off single scope: a day argument disambiguates among the multi-hit candidates', () => {
  const d1 = +dayjs('2026-11-01').startOf('day')
  const d2 = +dayjs('2026-11-02').startOf('day')
  const r1 = mkRow({ taskContent: 'w8 dupe task', repeatId: 'repeat_x1', dayStart: d1, todoTime: d1 })
  const r2 = mkRow({ taskContent: 'w8 dupe task', repeatId: 'repeat_x1', dayStart: d2, todoTime: d2 })
  const committed = []
  const lib = repeatFactory([r1, r2], { commitSpy: (ent, verb, p) => { if (ent === 'todo' && verb === 'put') committed.push(p) } })
  const out = lib.repeatOff('dupe', false, 20261102)
  assert.equal(out.removed, 1)
  assert.equal(committed.length, 1)
  assert.equal(committed[0].taskId, r2.taskId, 'the --day-matching instance is the one deleted')
  assert.equal(committed[0].delete, true)
})

test('#2c repeat off single scope: unique keyword hit keeps the legacy single-instance delete', () => {
  const r = mkRow({ taskContent: 'w8 solo task', repeatId: 'repeat_s1', dayStart: +dayjs('2026-11-01').startOf('day') })
  const committed = []
  const lib = repeatFactory([r], { commitSpy: (ent, verb, p) => { if (ent === 'todo' && verb === 'put') committed.push(p) } })
  const out = lib.repeatOff('solo', false)
  assert.equal(out.removed, 1)
  assert.equal(committed.length, 1)
  assert.equal(committed[0].taskId, r.taskId)
})

/* ================= #3 listTodos sentinel must not pollute JSON with a taskContent pseudo-row ================= */
function listTodosFactory (queryRows) {
  return require_('../../../cli/lib-tasks.cjs')({
    open: () => ({ call: (op) => { if (op === 'queryTodos') return queryRows; throw new Error('unexpected op ' + op) } }),
    CliError: FakeCliError,
    parseDate: s => s,
    dayjs,
    normKey: s => String(s || '').toLowerCase()
  })
}

test('#3 JSON output of a truncated list carries truncated:true WITHOUT an enumerable taskContent pseudo-row', () => {
  const real = [mkRow({ taskContent: 'w8 real #0' }), mkRow({ taskContent: 'w8 real #1' }), mkRow({ taskContent: 'w8 real #2' })]
  const lib = listTodosFactory(real)
  const rows = lib.listTodos({ keyword: 'w8', limit: 2 })
  assert.equal(rows.length, 3)
  const sentinel = rows[2]
  assert.equal(sentinel.truncated, true, 'truncated marker stays enumerable (existing JSON contract)')
  const jsonRound = JSON.parse(JSON.stringify(rows))
  assert.ok(!('taskContent' in jsonRound[2]), 'sentinel hint must NOT ride into JSON as taskContent')
  assert.equal(jsonRound[2].taskContent, undefined)
  assert.ok(!JSON.stringify(rows).includes('higher --limit'), 'hint text absent from the JSON payload')
  assert.match(sentinel.taskContent, /higher --limit/, 'text renderer still reads the hint verbatim')
  assert.deepEqual(Object.keys(jsonRound[0]).filter(k => k === 'taskContent'), ['taskContent'], 'real rows keep taskContent in JSON')
})

test('#3b under the cap: plain rows, no sentinel (unchanged)', () => {
  const real = [mkRow({ taskContent: 'w8 real #0' })]
  const lib = listTodosFactory(real)
  assert.deepEqual(lib.listTodos({ keyword: 'w8', limit: 200 }).map(r => r.truncated), [undefined])
})

/* ================= #4 corrupt allowed-backup-dirs.json warns instead of silent fall-through ================= */
const resolveCliBackupDir = require_('../../../cli/lib-restore-backup.cjs').resolveBackupDir

test('#4a corrupt whitelist JSON triggers the warn path (injected logger) and still falls back to the default root', () => {
  const ud = isolatedTmpDir('todo-w8-allowed-corrupt-')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'allowed-backup-dirs.json'), '{not json at all')
  const warns = []
  const fallback = resolveCliBackupDir('K:\\w8-not-registered', ud, m => warns.push(m))
  assert.ok(path.resolve(fallback) === path.resolve(require_('../../../src/main/backup-dirs.js').defaultBackupRootCandidates(ud)[0]),
    'fallback choice unchanged (default root)')
  assert.equal(warns.length, 1, 'exactly one warn for the corrupt whitelist')
  assert.ok(/allowed-backup-dirs/.test(warns[0]), 'warn names the whitelist file')
})

test('#4b unreadable whitelist (non-ENOENT fs error) warns too', () => {
  const ud = isolatedTmpDir('todo-w8-allowed-eacces-')
  fs.mkdirSync(ud, { recursive: true })
  const wl = path.join(ud, 'allowed-backup-dirs.json')
  fs.writeFileSync(wl, '[]')
  fs.chmodSync(wl, 0o000)
  const warns = []
  try {
    resolveCliBackupDir('K:\\w8-x', ud, m => warns.push(m))
  } finally { fs.chmodSync(wl, 0o644) }
  // On some platforms (Windows/root) a 0o000 file may still be readable — only assert when the read actually failed
  if (warns.length) assert.ok(/allowed-backup-dirs/.test(warns[0]))
})

test('#4c ENOENT (first run, no whitelist file) stays SILENT and falls back to the default root', () => {
  const ud = isolatedTmpDir('todo-w8-allowed-missing-')
  fs.mkdirSync(ud, { recursive: true })
  const warns = []
  const fallback = resolveCliBackupDir('K:\\w8-y', ud, m => warns.push(m))
  assert.equal(warns.length, 0, 'first-run ENOENT must not warn')
  assert.ok(fallback, 'still resolves to the default root')
})
