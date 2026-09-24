/* Round-6 (2026-09-21) regression suite — R6-A CLI findings + R6-B renderer findings.
   Locked behaviors:
   - r6-1  list <unknown-token> throws even with --all/--view (silent today-fallback killed)
   - r6-2  listTodos invalid --limit falls back to the 200 default, not 50
   - r6-3  planRemove defaults to the task's scheduled day (parity with planSet)
   - r6-4  settings manifest: calendarCategory is a number; restored tombstones stamp oldest
   - r6-5  refreshFromDb clears undo history (restore/CSV import cannot mass-tombstone on undo)
   - r6-6  contentFingerprint matches across panel-snapshot and raw-row vocabularies
*/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('r6-1: list unknown first token throws USAGE even when --all/--view present', () => {
  const src = require_('fs').readFileSync(path.join(root, 'cli/pickdone.js'), 'utf8')
  // The guard must key off the token's validity, not off the resolved range (which --all/--view null out)
  assert.match(src, /const validRange = \[/)
  assert.match(src, /if \(first && !validRange && !hasOn\) throw new lib\.CliError\(`unknown range/)
  // Old inverted guard must be gone
  assert.doesNotMatch(src, /!range && !opts\.all && !opts\.on\) throw/)
})

test('r6-2: listTodos invalid --limit falls back to the 200 default', async () => {
  const lib = require_(path.join(root, 'cli/lib.js'))
  // Behavioral probe (was source-regex-only, a tautology): seed >200 tasks in an isolated
  // TODO_DB_DIR, then the normalization seam must hold — invalid limit -> 200 rows, 1 -> 1 row.
  const os = (await import('node:os')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-2-limit-'))
  process.env.TODO_DB_DIR = dir
  try {
    const now = Date.now()
    for (let i = 0; i < 205; i++) {
      lib.addTodo({ content: 'r6-2 seed ' + i, createTime: new Date(now).toISOString() })
    }
    const invalid = lib.listTodos({ limit: 'abc' })
    assert.equal(invalid.length, 200, "limit:'abc' falls back to the 200 default, got " + invalid.length)
    assert.equal(lib.listTodos({ limit: '1' }).length, 1, 'limit:1 returns exactly 1 row')
    assert.equal(lib.listTodos({}).length, 200, 'absent limit defaults to 200')
  } finally {
    delete process.env.TODO_DB_DIR
    // The cached sqlite handle keeps todos.db locked on Windows — leave the tmpdir for OS cleanup.
  }
  // Source regex kept as a secondary seam guard (the normalization now lives in cli/lib-tasks.cjs)
  const src = require_('fs').readFileSync(path.join(root, 'cli/lib-tasks.cjs'), 'utf8')
  assert.match(src, /parseInt\(opts\.limit, 10\) \|\| 200, 500\)/)
  assert.ok(typeof lib.listTodos === 'function')
})

test('r6-3: planRemove derives the default day from the task scheduled day like planSet', () => {
  const src = require_('fs').readFileSync(path.join(root, 'cli/lib.js'), 'utf8')
  const fn = src.match(/function planRemove[\s\S]*?\n}/)[0]
  assert.match(fn, /planDayKey\(date != null && date !== true \? date : \(t\.dayStart \? dayjs\(t\.dayStart\)/, 'same default-day rule as planSet')
})

test('r6-4: settings manifest types calendarCategory as number', () => {
  // dw wave 3 (F-B9): SETTINGS_MANIFEST moved verbatim to shared/settings-manifest.mjs (cli/lib.js re-imports)
  const src = require_('fs').readFileSync(path.join(root, 'shared/settings-manifest.mjs'), 'utf8')
  const manifest = src.match(/const SETTINGS_MANIFEST[\s\S]*?\n}/)[0]
  assert.doesNotMatch(manifest, /string: \[[^\]]*calendarCategory/)
  assert.match(manifest, /number: \[[^\]]*'calendarCategory'\]/)
})

test('r6-5: _rt/refreshFromDb voids undo history before the whole-table replace', () => {
  const src = require_('fs').readFileSync(path.join(root, 'renderer/js/main.js'), 'utf8')
  const i = src.indexOf('async refreshFromDb')
  const body = src.slice(i, src.indexOf('\n  }', i))
  const iClear = body.indexOf("commit('todo/historyClear')")
  const iSet = body.indexOf("commit('todo/setAllRows'")
  assert.ok(iClear >= 0, 'historyClear present in refreshFromDb')
  assert.ok(iSet > iClear, 'history must be voided BEFORE the replacement snapshot lands')
})

test('r6-6: contentFingerprint is vocabulary-agnostic (panel snapshot vs raw row agree)', async () => {
  const { contentFingerprint } = await import(pathToFileURL(path.join(root, 'renderer/js/utils/editPanelRemoteSync.js')).href)
  const panelShape = { title: 'Buy milk', desc: '2L', dateTs: 1700000000000, remindTs: 0, priority: 0, important: 0, categoryId: 3 }
  const rawRow = { taskContent: 'Buy milk', taskDescribe: '2L', todoTime: 1700000000000, reminderTime: 0, priority: 0, important: 0, categoryId: 3 }
  assert.equal(contentFingerprint(panelShape), contentFingerprint(rawRow), 'same content, different vocabularies -> same fingerprint')
  assert.notEqual(contentFingerprint(panelShape), contentFingerprint({ ...rawRow, taskContent: 'Buy bread' }), 'a real peer edit still changes it')
  // Mixed-shape rows (partially hydrated) resolve panel key first, fall back to row key
  assert.equal(contentFingerprint({ title: 'X', todoTime: 5 }), contentFingerprint({ taskContent: 'X', todoTime: 5 }))
})

/* F1 (2026-09-23, main-process quit chain): tray quit used to tear down a running pomodoro
   silently — no confirm, no partial ledger record. The main process has exactly one running-state
   signal (the per-second taskbar push routed through updateTomatoTray); the tray quit must gate
   on it and ask before quitting. Electron main isn't unit-runnable, so this pins the wiring
   contract (dialog present, cancel restores quitByUser, direct quit unchanged when idle). */
test('r6-7: tray quit confirms before abandoning a running pomodoro', () => {
  const src = require_('fs').readFileSync(path.join(root, 'src/main/index.js'), 'utf8')
  const i = src.indexOf('async function quitFromTray')
  assert.ok(i > 0, 'quitFromTray exists')
  const body = src.slice(i, src.indexOf('\n}', i))
  // The confirm keys off the live pomodoro signal, not an unconditional dialog
  assert.match(body, /if \(tomatoLiveText\)/, 'confirm only while a pomodoro is live')
  assert.match(body, /dialog\.showMessageBox/, 'main-process dialog is the confirm vehicle')
  assert.match(body, /cancelId: 1/, 'cancel is the safe default choice')
  assert.match(body, /response !== 0[\s\S]*?quitByUser = false/, 'cancelling restores the quit intent (no zombie half-quit state)')
  assert.match(body, /app\.quit\(\)/, 'confirming proceeds to app.quit()')
  // The tray menu routes through quitFromTray (no duplicated bare app.quit() left in the tray item)
  assert.doesNotMatch(src, /label: i18nM\.mt\('trayQuit'\)[^}]*app\.quit\(\)/, 'trayQuit click no longer quits bare')
  // The i18n surface carries the copy in BOTH locales
  const i18n = require_('fs').readFileSync(path.join(root, 'src/main/i18n.js'), 'utf8')
  for (const key of ['quitFocusActiveTitle', 'quitFocusActiveMsg', 'quitFocusQuit', 'quitFocusCancel']) {
    assert.equal(i18n.split(key).length - 1, 2, `i18n key ${key} present in zh-CN AND en`)
  }
})

/* F5 (2026-09-23, 完成日口径): complete=1 && completedAt=0 的历史/异常行在 App 侧
   (metrics.js doneTsOf / store todayDoneList)按 updateTime 兜底计入,CLI/DB 侧却永不计入 —
   三侧在同一 commit 内对齐到 App 语义。 */
test('r6-8: CLI overview.doneToday and DB statsByDay count completedAt=0 rows via the updateTime fallback (App parity)', () => {
  const osDefault = require_('os')
  const dayjs = require_('dayjs')
  const dir = fs.mkdtempSync(path.join(osDefault.tmpdir(), 'r6-8-done-day-'))
  process.env.TODO_DB_DIR = dir
  try {
    const db = require_(path.join(root, 'src/main/db.js'))
    db.init(dir)
    const lib = require_(path.join(root, 'cli/lib.js'))
    const now = Date.now()
    const weekAgo = now - 7 * 86400000
    // A completedAt=0 completed row edited today (the legacy/abnormal shape) must count as done
    // TODAY on every side; a control row completed last week must stay in its own day.
    db.call('upsertMany', [
      { taskId: 'r6-8-a', taskContent: 'legacy completed row', createTime: weekAgo, updateTime: now, delete: 0, complete: 1, completedAt: 0, todoTime: weekAgo, taskSort: 1 },
      { taskId: 'r6-8-b', taskContent: 'week-old completion', createTime: weekAgo, updateTime: weekAgo, delete: 0, complete: 1, completedAt: weekAgo, todoTime: weekAgo, taskSort: 2 },
    ])
    const ov = lib.overview()
    assert.equal(ov.today.doneToday, 1, 'CLI overview.doneToday counts the completedAt=0 row via the updateTime fallback')
    const byDay = db.call('statsByDay', { from: now - 30 * 86400000, to: now })
    const totalDone = byDay.doneByCompletionDay.reduce((s, r) => s + (r.n || 0), 0)
    assert.equal(totalDone, 2, 'DB doneByCompletionDay counts BOTH completed rows (pre-fix it silently dropped the completedAt=0 one)')
    const todayKey = Number(dayjs(now).format('YYYYMMDD'))
    const todayRow = byDay.doneByCompletionDay.find(r => Number(r.ds) === todayKey)
    assert.ok(todayRow && todayRow.n >= 1, 'the fallback row lands in TODAY\'s completion-day bucket')
  } finally {
    delete process.env.TODO_DB_DIR
  }
})
