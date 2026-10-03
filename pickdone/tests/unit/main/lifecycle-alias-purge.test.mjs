/* Lifecycle wave 2026-10-02 — attachment alias-map lifecycle (harness: daily-0924-todo-handlers
 * pattern — real temp DB + real command bus, electron stubbed):
 * [LC-A1] db:purge-recycle-bin prunes alias entries whose TARGET file the purge just removed —
 *         they used to leak forever in aliases.json AND kept resolving the dead logical key to a
 *         missing file, so open-file's missing-file guard could never re-pull the original key.
 * [LC-A2] delete-todo-files gets the same alias cleanup (same defect, sibling entry door).
 * [LC-A3] aliases.json is bookkeeping, not an attachment: excluded from the quota scanners
 *         (dirUsage/dirTotalBytes) like the noise-custom slot.
 * Fails without the fix: A1/A2 leave the stale alias in aliases.json; A3 counts aliases.json.
 * Run: node --test tests/unit/main/lifecycle-alias-purge.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-alias-'))

const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const realDb = require_('../../../src/main/db.js')
realDb.init(process.env.TODO_DB_DIR)
const todoHandlers = require_('../../../src/main/handlers/todo.js')
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')
const attachments = require_('../../../src/main/attachments.js')

const MAIN = { webContents: { id: 'main' } }
const eMain = { sender: MAIN.webContents }
const AT = () => attachments.attachDir() // module attachDir appends a 'files' subdir
fs.mkdirSync(AT(), { recursive: true })
const writeAliasFile = map => fs.writeFileSync(attachments.aliasesPath(), JSON.stringify(map, null, 1))
const readAliasFile = () => JSON.parse(fs.readFileSync(attachments.aliasesPath(), 'utf8'))
const api = todoHandlers({
  isLocked: () => false,
  isLockWindow: () => false,
  getMainWindow: () => MAIN,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: () => {},
  broadcastTodosChanged: () => {},
  dbApi: () => realDb,
  attachDir: AT,
  notifySyncChange: () => {}
})
const fileApi = attachmentHandlers({
  isLocked: () => false,
  isSafeExternal: () => false,
  getMainWindow: () => MAIN,
  broadcastWhiteNoiseUpdated: () => {},
  notifySyncChange: () => {},
  attachDir: AT
})

const baseTask = (taskId, extra = {}) => ({
  taskId, taskContent: 'c-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', version: 0, ...extra,
})

test('LC-A1: purge-recycle-bin prunes aliases whose target file was purged, keeps live-target aliases', () => {
  // recycle-bin row owning the conflict-renamed file `task-purged-1_…_purged-1.png`; the synced
  // row references the ORIGINAL logical key `purged.png` which resolves through the alias map.
  realDb.call('upsert', baseTask('task-purged-1', {
    delete: true,
    image: JSON.stringify([{ url: 'local://purged.png' }])
  }))
  // live row whose alias target stays on disk — its alias must survive the purge
  realDb.call('upsert', baseTask('task-live-1', {
    image: JSON.stringify([{ url: 'local://kept.png' }])
  }))
  fs.writeFileSync(path.join(AT(), 'task-purged-1_1700000000_purged-1.png'), 'purged-bytes')
  fs.writeFileSync(path.join(AT(), 'task-live-1_1700000000_kept-1.png'), 'kept-bytes')
  writeAliasFile({ 'purged.png': 'task-purged-1_1700000000_purged-1.png', 'kept.png': 'task-live-1_1700000000_kept-1.png' })

  const r = api['db:purge-recycle-bin'](eMain)
  assert.ok(r, 'purge committed')
  assert.ok(!fs.existsSync(path.join(AT(), 'task-purged-1_1700000000_purged-1.png')), 'owned file purged')
  const map = readAliasFile()
  assert.ok(!('purged.png' in map), 'stale alias for the purged target file must be pruned — got: ' + JSON.stringify(map))
  assert.equal(map['kept.png'], 'task-live-1_1700000000_kept-1.png', 'alias whose target still exists must survive')
})

test('LC-A2: delete-todo-files prunes aliases for the task-owned files too', () => {
  // conflict rename keeps the ownership prefix: `..._z.png` → `..._z-1.png` (att-transfer writeAtomic)
  fs.writeFileSync(path.join(AT(), 'task-del-9_1700000000_z-1.png'), 'z-conflict-bytes')
  writeAliasFile({ 'z.png': 'task-del-9_1700000000_z-1.png', 'unrelated.png': 'unrelated-1.png' })
  fs.writeFileSync(path.join(AT(), 'unrelated-1.png'), 'u-bytes')

  const r = fileApi['delete-todo-files'](eMain, 'task-del-9')
  assert.equal(r, true, 'delete-todo-files succeeds')
  assert.ok(!fs.existsSync(path.join(AT(), 'task-del-9_1700000000_z-1.png')), 'owned conflict file deleted')
  const map = readAliasFile()
  assert.ok(!('z.png' in map), 'stale alias must be pruned — got: ' + JSON.stringify(map))
  assert.equal(map['unrelated.png'], 'unrelated-1.png', 'unrelated alias untouched')
})

test('LC-A3: aliases.json is excluded from the quota scanners (bookkeeping, not an attachment)', () => {
  // isolated scan dir: the harness shares the DB dir with the attachment dir, so counting there
  // would also pick up todos.db/-wal — the quota scanners get their own directory.
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-alias-quota-'))
  fs.writeFileSync(path.join(scanDir, 'real_1700000000_a.png'), 'abcde')
  fs.writeFileSync(path.join(scanDir, 'aliases.json'), JSON.stringify({ 'real.png': 'real-1.png' }, null, 1))
  const usage = attachments.dirUsage(scanDir)
  assert.equal(usage.count, 1, 'aliases.json must not count toward MAX_FILES — got count ' + usage.count)
  assert.equal(usage.bytes, 5, 'aliases.json bytes must not count toward the 64MB budget')
  assert.equal(attachments.dirTotalBytes(scanDir), 5, 'dirTotalBytes excludes aliases.json')
})
