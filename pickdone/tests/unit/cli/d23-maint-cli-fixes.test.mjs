/**
 * maint/d23 round — CLI fixes:
 *  - P1 settings blob whitelist rebuild no longer wipes the security-lock secrets
 *    (SECRET_KEYS) or the doneGroupsFoldMigrated marker on any `settings set`;
 *  - P3 focus: `tomato record fix --rest` is strict-parsed (USAGE on garbage/negative, same
 *    contract as --minutes) instead of silently zeroing restDuration;
 *  - P3 focus: backfill tomatoId mixes the FULL taskId (same last-8 tail no longer collides
 *    into a silent ON CONFLICT overwrite);
 *  - P3 date: dateChangeReminderPatch keeps the NEW timestamp's seconds/millis (EditPanel
 *    parity) instead of copying the old reminder's sub-minute part;
 *  - P3 backup dirs: evt-snapshot dir + restore discovery go through resolveBackupDir
 *    semantics (relative / non-whitelisted backupDir fall back to the default root);
 *  - P3 evt-purge capture also records repeatRule:<rid> meta for captured repeating rows.
 * Run: node --test tests/unit/cli/d23-maint-cli-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

delete process.env.TODO_BACKUP_DIR // the fallback-root semantics under test assume the env override is absent
process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d23-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)
const ud = process.env.TODO_DB_DIR

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'd23 task', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------- P1: settings blob rebuild keeps secrets + migration markers ---------- */
test('d23 P1: settings set preserves securityLock secrets and doneGroupsFoldMigrated in the blob', () => {
  // Seat the blob the way the App does: secrets + migration marker live ONLY here (machine-local).
  const seeded = {
    enableSecurityLock: true,
    securityLockPassword: 's3cret-hash',
    securityLockQuestion: 'what is my quest',
    doneGroupsFoldMigrated: true,
    schemaV: 1
  }
  db.call('setMeta', ['db.settingsState', JSON.stringify(seeded)])
  // Any manifest-declared write — the whitelist rebuild runs on every one of them.
  lib.settingsSet('showTagPanel', 'true')
  const blob = JSON.parse(db.call('getMeta', 'db.settingsState'))
  assert.equal(blob.securityLockPassword, 's3cret-hash', 'red before the fix: the whitelist rebuild dropped the secret')
  assert.equal(blob.securityLockQuestion, 'what is my quest', 'red before the fix: the whitelist rebuild dropped the secret')
  assert.equal(blob.enableSecurityLock, true)
  assert.equal(blob.doneGroupsFoldMigrated, true, 'red before the fix: the migration marker was dropped (done groups re-folded)')
  assert.equal(blob.showTagPanel, true, 'the written key itself still lands')
})

/* ---------- P3: milestone task fetch raised to App parity ---------- */
test('d23 P3: milestone listing fetches up to 5000 tasks (pin, D19 parity)', () => {
  const src = fs.readFileSync(new URL('../../../cli/lib-taxonomy.cjs', import.meta.url), 'utf8')
  const milestoneFetch = src.match(/runMilestone[\s\S]*?listTodos\(\{[^}]*limit:\s*(\d+)/)
  assert.ok(milestoneFetch, 'runMilestone must call listTodos')
  assert.equal(Number(milestoneFetch[1]), 5000, 'red before the fix: milestone task fetch stayed at the old 500 cap')
})

/* ---------- P3: record fix --rest strict parse ---------- */
test('d23 P3: tomato record fix --rest rejects garbage with USAGE instead of zeroing restDuration', () => {
  const t = seed({ taskContent: 'd23 rest garbage' })
  const rec = lib.backfillRecord({ taskId: t.taskId, content: 'focus', date: '2026-10-01', at: '09:00', minutes: 25 })
  db.call('tomatoUpdateById', { tomatoId: rec.tomatoId, patch: { restDuration: 15, rest: 1 } })
  assert.throws(() => lib.recordFix(rec.tomatoId, { rest: 'abc' }), e => e.code === 'USAGE' && /rest duration/.test(e.message), 'red before the fix: parseInt||0 silently zeroed it')
  assert.throws(() => lib.recordFix(rec.tomatoId, { rest: '-5' }), e => e.code === 'USAGE')
  assert.throws(() => lib.recordFix(rec.tomatoId, { rest: '0' }), e => e.code === 'USAGE')
  // The record must be untouched by the failed fix.
  const after = lib.resolveRecord(rec.tomatoId)
  assert.equal(after.restDuration, 15, 'a rejected --rest must not write a zeroed restDuration')
  // A legitimate value still applies (and still honors the DB-layer REST_MAX_MINUTES clamp as USAGE).
  lib.recordFix(rec.tomatoId, { rest: '20' })
  assert.equal(lib.resolveRecord(rec.tomatoId).restDuration, 20)
})

/* ---------- P3: backfill tomatoId mixes the full taskId ---------- */
test('d23 P3: backfills for taskIds sharing the last 8 chars never collide', () => {
  const day = '2026-10-02'
  const a = seed({ taskContent: 'd23 tail-A' }); const b = seed({ taskContent: 'd23 tail-B' })
  const tailA = 'tid_1_abcdefgh'; const tailB = 'tid_2_abcdefgh'
  // Rename the real ids into the collision shape via direct rows is awkward — backfill accepts
  // arbitrary taskId strings, so use the collision-shaped ids directly (format-safe charset).
  const r1 = lib.backfillRecord({ taskId: tailA, content: 'A', date: day, at: '10:00', minutes: 25 })
  const r2 = lib.backfillRecord({ taskId: tailB, content: 'B', date: day, at: '10:00', minutes: 25 })
  assert.notEqual(r1.tomatoId, r2.tomatoId, 'red before the fix: slice(-8) tails collided -> ON CONFLICT overwrote the first row')
  assert.ok(r1.tomatoId.includes(tailA), 'the id carries the full taskId')
  const rows = db.call('tomatoAll').filter(r => r.dateKey === day && r.manual)
  assert.equal(rows.filter(r => r.focus === 'A' || r.focus === 'B').length, 2, 'both ledger rows must exist (no silent overwrite)')
  // Idempotency contract intact: the same slot again produces no second row.
  lib.backfillRecord({ taskId: tailA, content: 'A', date: day, at: '10:00', minutes: 25 })
  const rows2 = db.call('tomatoAll').filter(r => r.dateKey === day && r.manual)
  assert.equal(rows2.filter(r => r.focus === 'A').length, 1, 'repeat import of the same slot stays a no-op')
  assert.ok(a && b) // seeded, keeps the DB non-trivial
})

/* ---------- P3: reminder re-anchor keeps the NEW timestamp's seconds ---------- */
test('d23 P3: dateChangeReminderPatch lands the new reminder on :00 (old :07 seconds dropped)', () => {
  const oldReminder = +dayjs('2026-10-05T08:30:07.123')
  const patch = lib.dateChangeReminderPatch(
    { reminderTime: oldReminder, reminderExtra: [], todoTime: +dayjs('2026-10-05').startOf('day') },
    +dayjs('2026-10-06').startOf('day') // explicit date → seconds/millis are 0 (EditPanel.applyDate)
  )
  const got = dayjs(patch.reminderTime)
  assert.equal(got.format('YYYY-MM-DD HH:mm'), '2026-10-06 08:30', 'hour/minute still carried from the old reminder')
  assert.equal(got.second(), 0, 'red before the fix: the OLD reminder :07 seconds were copied over')
  assert.equal(got.millisecond(), 0, 'red before the fix: the OLD reminder millis were copied over')
})

/* ---------- P3: evt-snapshot dir resolves like the App (resolveBackupDir twin) ---------- */
test('d23 P3: resolveCliBackupDir twin falls back for relative and non-whitelisted dirs', () => {
  const resolve = require_('../../../cli/lib-restore-backup.cjs').resolveBackupDir
  const fallback = path.join(ud, 'backups')
  assert.equal(resolve('', ud), fallback, 'empty backupDir → default root')
  assert.equal(resolve('relative-dir', ud), fallback, 'red before the fix: a relative backupDir was used raw')
  assert.equal(resolve(path.join(ud, 'nowhere-else'), ud), fallback, 'red before the fix: a non-whitelisted abs dir was used raw')
  const allowed = path.join(ud, 'picked')
  fs.mkdirSync(allowed, { recursive: true })
  fs.writeFileSync(path.join(ud, 'allowed-backup-dirs.json'), JSON.stringify([allowed]))
  assert.equal(resolve(allowed, ud), path.resolve(allowed), 'a whitelisted dir is honored')
  assert.equal(resolve('./' + path.basename(allowed), ud), fallback, 'a relative spelling of a whitelisted name still falls back (App resolves before whitelisting)')
})

test('d23 P3: purge evt-snapshot lands in the resolved default root + captures repeatRule meta', () => {
  // Repeating task, deleted to the recycle bin, then purged.
  const wed = +dayjs('2026-10-14').startOf('day')
  const t = seed({ taskContent: 'd23 repeating purge', todoTime: wed })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 2)
  assert.ok(r && r.rid, 'repeat rule registered')
  lib.deleteTodo(t.taskId)
  lib.purgeRecycleBin()
  const root = path.join(ud, 'backups')
  const snaps = fs.existsSync(root) ? fs.readdirSync(root).filter(f => /^evt-purge-/.test(f)) : []
  assert.ok(snaps.length, 'red before the fix: a relative/unresolved backupDir sent snapshots elsewhere or nowhere')
  const snap = JSON.parse(fs.readFileSync(path.join(root, snaps.sort().pop()), 'utf8'))
  const metaKeys = ((snap.backup && snap.backup.metaEntries) || []).map(m => m.key)
  assert.ok(metaKeys.includes('repeatRule:' + r.rid), 'red before the fix: the captured rows lost their repeatRule meta (B5 dangling chain)')
})

test('d23 P3: purge evt-snapshot honors a whitelisted user backupDir', () => {
  const picked = path.join(ud, 'picked')
  fs.mkdirSync(picked, { recursive: true })
  fs.writeFileSync(path.join(ud, 'allowed-backup-dirs.json'), JSON.stringify([picked]))
  lib.settingsSet('backupDir', picked) // the twin reads the same settingsDoc the purge uses
  const t = seed({ taskContent: 'd23 whitelisted purge' })
  lib.deleteTodo(t.taskId)
  lib.purgeRecycleBin()
  const snaps = fs.readdirSync(picked).filter(f => /^evt-purge-/.test(f))
  assert.ok(snaps.length, 'a whitelisted backupDir keeps receiving the CLI snapshots')
})
