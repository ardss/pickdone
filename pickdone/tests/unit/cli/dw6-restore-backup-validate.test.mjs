/**
 * dw-wave6 F14+F15 — CLI `restore-backup` must read the REAL dump shape and the REAL backup dir.
 * F14 regression: validation read legacy top-level keys (todos/todoList/categories/meta) that no
 * real renderer dump carries — every real snapshot nests its segments under dump.backup.* as JSON
 * strings, so ANY parseable JSON printed "Snapshot OK" with null counts (confirmed by simulating
 * the summary expression in node: output was null for every input).
 * F15 regression: discovery only looked at the two hardcoded candidate dirs; snapshots actually
 * land in resolveBackupDir(settings.backupDir), so a user-chosen backup dir showed
 * "(no auto-*.json snapshots)" while the App had plenty.
 * Isolated temp DB via TODO_DB_DIR (unit-cli pattern); never touches real data.
 * Run: node --test tests/unit/cli/dw6-restore-backup-validate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-restorebak-'))
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)
const dbm = require_(path.join(ROOT, 'src/main/db.js'))
dbm.init(process.env.TODO_DB_DIR)

const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCli = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })).data
const runCliFail = args => {
  try { execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return null } catch (e) {
    try { return JSON.parse(e.stderr || e.stdout) } catch { return { error: 'UNKNOWN', message: String(e.message) } }
  }
}

function realDump ({ todos = 3, cats = 2, schemaV = 1 } = {}) {
  return JSON.stringify({
    backup: {
      settingsState: JSON.stringify({ backupDir: '', schemaV: 1 }),
      todoState: JSON.stringify({
        schemaV, version: 0, remoteVersion: 0, todayTimestamp: Date.now(), ignoreReminder: {}, todosVersion: '0', isSyncing: false, views: {},
        todoList: Array.from({ length: todos }, (_, i) => ({ taskId: 'rt' + i, taskContent: '任务' + i })),
        recycleList: [{ taskId: 'rb1', taskContent: '回收站', delete: true }]
      }),
      tomatoRecords: JSON.stringify([]),
      categoryState: JSON.stringify({ schemaV, list: Array.from({ length: cats }, (_, i) => ({ categoryId: i + 1, categoryName: '分类' + i })) })
    }
  })
}

test('F14: a real renderer-shape dump validates with real counts (todos = todoList+recycleList)', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'real-dump.json')
  fs.writeFileSync(f, realDump({ todos: 3, cats: 2 }))
  const out = runCli(['restore-backup', f, '--json'])
  assert.equal(out.todos, 4, '3 main + 1 recycle row counted from the real todoState segment (old code: null)')
  assert.equal(out.categories, 2, 'categories counted from the real categoryState segment')
  assert.ok(out.segments >= 4, 'the dump segment count is reported')
  assert.equal(out.savedAt != null, true, 'savedAt falls back to todoState.todayTimestamp')
})

test('F14: non-dump JSON is rejected, not greeted with "Snapshot OK"', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'garbage.json')
  fs.writeFileSync(f, JSON.stringify({ foo: 1, todos: 'not-an-array' }))
  const r = runCliFail(['restore-backup', f, '--json'])
  assert.equal(r && r.error, 'SNAPSHOT_INVALID', 'a JSON with no backup segments must fail validation')
  assert.match(r && r.message, /not a pickdone backup dump/)
})

test('F14: schemaV>1 segment is refused with SNAPSHOT_FUTURE (same guard as the restore side)', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'future-dump.json')
  fs.writeFileSync(f, realDump({ schemaV: 2 }))
  const r = runCliFail(['restore-backup', f, '--json'])
  assert.equal(r && r.error, 'SNAPSHOT_FUTURE', 'a future-version segment must not be misread')
  assert.match(r && r.message, /schemaV=2/)
})

test('F15: discovery lists snapshots from the user-chosen settings.backupDir', () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-user-backupdir-'))
  try {
    fs.writeFileSync(path.join(userDir, 'auto-20260924-120000.json'), realDump({ todos: 1, cats: 0 }))
    // Point settings.backupDir at it (blob only; settings_rows overlay absent → doc = blob)
    dbm.call('setMeta', ['db.settingsState', JSON.stringify({ schemaV: 1, backupDir: userDir })])
    const out = runCli(['restore-backup', '--json'])
    const found = (out.snapshots || []).find(s => s.file === 'auto-20260924-120000.json')
    assert.ok(found, 'the snapshot in the user-chosen dir is listed (old code: "(no auto-*.json snapshots)")')
    assert.equal(path.resolve(found.dir), path.resolve(userDir), 'the listed dir is the user-chosen one')
    assert.ok(Array.isArray(out.backupDir) && out.backupDir.length >= 2, 'all candidate dirs are reported')
  } finally { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3 }) }
})
