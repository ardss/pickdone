/**
 * D21-DOMB regression batch (2026-10-02):
 *  [B2]  `add --reminder` on a DATELESS task backfills the date to the reminder's day
 *        (D19 edit-path parity, cli/pickdone.js reminderDateBackfill twin)
 *  [B4]  attachment writes spool to `.att-tmp-*` + rename (App parity attachments.js saveAttachment)
 *  [B8]  evt snapshot prune keeps 10 PER REASON (App parity autoBackup.evtGroups), not 10 total
 *  [B9]  buildRepeatRule seeds from the synced settings doc's repeatDefaultSettings
 *        (REPEAT_DEFAULTS fallback for absent fields)
 *  [B10] priority/difficulty are bounded 0-3 on BOTH add (lib.addTodo) and edit (pickdone.js)
 *  [B9b] milestone id mint: longer randomness + collision re-mint (no same-ms silent collapse)
 * Run: node --test tests/unit/cli/d21-domb-fixes.test.mjs
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-d21-domb-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..')
const ENV = { ...process.env, TODO_DB_DIR: process.env.TODO_DB_DIR }
const run = (args) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8', env: ENV, timeout: 120000 }))

const dayjs = require_('dayjs')

test('B2: add --reminder on a dateless task backfills the date to the reminder day', () => {
  const t = lib.addTodo({ content: 'd21 dateless reminder', reminder: '2026-10-05 09:00' })
  const row = db.call('getById', t.taskId)
  assert.equal(row.reminderTime, +dayjs('2026-10-05 09:00'), 'main reminder written verbatim')
  assert.equal(row.todoTime, +dayjs('2026-10-05').startOf('day'), 'date backfilled to the reminder day (edit-path D19 twin)')
})

test('B2: a dateless add WITHOUT a reminder stays dateless', () => {
  const t = lib.addTodo({ content: 'd21 plain dateless' })
  assert.equal(db.call('getById', t.taskId).todoTime, 0)
})

test('B2: an explicit date wins over the reminder backfill (no override)', () => {
  const t = lib.addTodo({ content: 'd21 dated+reminder', date: '2026-11-01', reminder: '2026-10-05 09:00' })
  assert.equal(db.call('getById', t.taskId).todoTime, +dayjs('2026-11-01').startOf('day'))
})

test('B10: add rejects priority/difficulty outside 0-3 with a CliError naming the range', () => {
  assert.throws(() => lib.addTodo({ content: 'd21 p5', priority: 5 }), e => /0-3/.test(e.message))
  assert.throws(() => lib.addTodo({ content: 'd21 d4', difficulty: 4 }), e => /0-3/.test(e.message))
  const t = lib.addTodo({ content: 'd21 p3', priority: 3, difficulty: 2 })
  const row = db.call('getById', t.taskId)
  assert.equal(row.priority, 3)
  assert.equal(row.difficulty, 2)
  assert.equal(row.important, 0, 'add keeps App parity: NO priority 3 -> important=1 derivation at create time')
})

test('B10: edit rejects out-of-range priority/difficulty via the pickdone entry', () => {
  const t = lib.addTodo({ content: 'd21 edit clamp' })
  assert.throws(() => run(['edit', t.taskId, '--priority', '9']), e => /0-3/.test(String(e.stderr || e.message)))
  assert.throws(() => run(['edit', t.taskId, '--difficulty', '7']), e => /0-3/.test(String(e.stderr || e.message)))
  const res = run(['edit', t.taskId, '--priority', '3', '--json'])
  assert.ok(res, 'in-range edit succeeds')
  assert.equal(db.call('getById', t.taskId).priority, 3)
})

test('B4: attachment write lands via tmp spool + rename (no .att-tmp residue, final file present)', () => {
  const t = lib.addTodo({ content: 'd21 attach' })
  const tmpSrc = path.join(os.tmpdir(), 'd21-domb-attach-' + Date.now() + '.png')
  fs.writeFileSync(tmpSrc, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  const res = lib.addAttachment(t.taskId, tmpSrc)
  fs.unlinkSync(tmpSrc)
  const dir = path.join(lib.userDataDir(), 'files')
  const finalName = decodeURIComponent(res.name) // res.name is the RAW basename here
  const safeKey = decodeURIComponent(JSON.parse(db.call('getById', t.taskId).image)[0].url.replace(/^local:\/\//, ''))
  assert.ok(fs.existsSync(path.join(dir, safeKey)), 'final file exists after rename')
  const residue = fs.readdirSync(dir).filter(f => /\.att-tmp-\d+-\d+$/.test(f))
  assert.equal(residue.length, 0, 'no .att-tmp residue left after a successful write')
  void finalName
})

test('B9: buildRepeatRule seeds from the synced repeatDefaultSettings with REPEAT_DEFAULTS fallback', () => {
  // settings_rows is the field-granular sync truth settingsDoc() overlays over the blob
  db.call('settingsRowPut', { key: 'repeatDefaultSettings', value: { repeatDayCount: 42, repeatWeekCount: 7 } })
  const daily = lib.buildRepeatRule({ type: 'daily' })
  assert.equal(daily.repeatDayCount, 42, 'user default interval/count honored')
  assert.equal(daily.repeatWeekCount, 7, 'absent-for-this-type field still falls through to the user doc value')
  assert.equal(daily.repeatInterval, 1, 'unset field falls back to REPEAT_DEFAULTS')
  // empty doc -> pure REPEAT_DEFAULTS seed (previous behavior preserved)
  db.call('settingsRowPut', { key: 'repeatDefaultSettings', value: {} })
  const plain = lib.buildRepeatRule({ type: 'daily' })
  assert.equal(plain.repeatDayCount, 90)
  assert.equal(plain.repeatWeekCount, 52)
})

test('B8: evt snapshot prune keeps 10 PER REASON (one noisy reason cannot starve another)', () => {
  const evtb = require_('../../../cli/lib-eventbackup.cjs') // direct module export (not re-exported via lib.js)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd21-evt-'))
  const mk = (reason, i) => {
    const d = new Date(2026, 8, 1, 0, i, 0)
    const pad = n => String(n).padStart(2, '0')
    const name = `evt-${reason}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`
    fs.writeFileSync(path.join(dir, name), '{}')
  }
  for (let i = 0; i < 12; i++) mk('cleanup', i) // noisy reason
  for (let i = 20; i < 24; i++) mk('purge', i) // quiet reason: 4 snapshots
  const res = evtb.writePurgeEventSnapshot({ dir, rows: [], liveRows: [], metaEntries: [], reason: 'purge' })
  assert.ok(res.ok, 'snapshot write ok')
  const left = fs.readdirSync(dir).filter(f => /^evt-/.test(f))
  const cleanups = left.filter(f => f.startsWith('evt-cleanup-'))
  const purges = left.filter(f => f.startsWith('evt-purge-'))
  assert.equal(cleanups.length, 10, 'cleanup keeps 10 of its own')
  assert.equal(purges.length, 5, 'purge keeps ALL 4 pre-existing + the new one (was starved to 0 under the flat 10-total rule)')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('B9b: milestone ids are unique across same-ms creation and echoed by id', () => {
  lib.addCategory('d21Proj')
  const a = lib.addMilestone('d21Proj', 'M1', '2026-10-05')
  const b = lib.addMilestone('d21Proj', 'M2', '2026-10-06')
  assert.notEqual(a.added.id, b.added.id, 'two milestones minted back-to-back never share an id')
  assert.ok(a.added.id.length > 'ms_'.length + 13 + 6, 'mint carries longer randomness than the old 4-char tail')
  assert.equal(a.added.title, 'M1', 'add echoes the row it actually added (id-keyed lookup)')
  assert.equal(b.added.title, 'M2')
  const list = lib.getMilestones('d21Proj').milestones
  assert.equal(new Set(list.map(m => m.id)).size, list.length, 'stored blob has no id collapse')
})
