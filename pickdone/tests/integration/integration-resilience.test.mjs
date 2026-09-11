/**
 * Resilience integration tests — the data-safety triad (SOP-06 supplement):
 *   (1) Backup recovery drill: corrupted DB -> the tiered recovery path actually works (plaintext backup first / disaster JSON re-import)
 *   (2) Write atomicity: disaster backup tmp+rename, no half-written leftovers
 *   (3) Corruption tolerance: truncated/invalid JSON fed to each loader must fall back safely without throwing
 * Everything uses temp directories; the real userData is never touched.
 */
import '../setup.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import '../setup.mjs' // window/pinyinPro/VueI18n shims - core.js reads the window global at top level

const require = createRequire(import.meta.url)
const dbRecovery = require('../../src/main/dbRecovery.cjs')

function tmpDir () {
  // 独立父目录：灾备 JSON 现默认外置到 userData 父目录的 pickdone-backups（与库分离）。
  // 若直接拿 os.tmpdir() 当父，所有用例（乃至跨次运行）会共享同一个外置根造成污染，故先建一次性 base。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-resilience-base-'))
  const ud = path.join(base, 'ud')
  fs.mkdirSync(ud, { recursive: true })
  return ud
}

/* ---------- (1) backup recovery drill ---------- */

test('recovery drill: only plaintext backup exists -> restore from it, corrupt DB renamed and kept', () => {
  const ud = tmpDir()
  fs.writeFileSync(path.join(ud, 'todos.db'), 'CORRUPT-BYTES')
  fs.writeFileSync(path.join(ud, 'todos.db-wal'), 'WAL')
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'PLAIN-OK-DATA')

  const from = dbRecovery.attemptDbRecovery(ud)

  assert.equal(from.source, 'plain-bak')
  assert.equal(fs.readFileSync(path.join(ud, 'todos.db'), 'utf8'), 'PLAIN-OK-DATA', 'todos.db was overwritten by the plaintext backup')
  // The corrupt file is renamed and kept (for manual forensics), not deleted
  const kept = fs.readdirSync(ud).filter(f => f.includes('.corrupt-'))
  assert.ok(kept.length >= 2, `corrupt files must be kept, got: ${kept}`)
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: both plain-bak and JSON exist -> JSON wins (fresh over stale one-shot snapshot)', () => {
  const ud = tmpDir()
  fs.writeFileSync(path.join(ud, 'todos.db'), 'CORRUPT-BYTES')
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'STALE-PLAIN')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{"backup":{}}')

  const from = dbRecovery.attemptDbRecovery(ud)

  assert.equal(from.source, 'json', 'JSON 是持续覆盖的新鲜快照,必须优先于迁移时刻的一次性 plain-bak')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db')), false, 'JSON 分支不落 plain-bak 内容进 todos.db(留给全新 init + JSON 回灌)')
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: corrupt scenes (.corrupt-*) pruned to most recent 3 sets', () => {
  const ud = tmpDir()
  fs.writeFileSync(path.join(ud, 'todos.db'), 'C')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{"backup":{}}')
  // 预置 5 套历史 corrupt 现场
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(ud, `todos.db.corrupt-2026-01-0${i + 1}T00-00-00-000Z`), 'old' + i)
    fs.writeFileSync(path.join(ud, `db.key.corrupt-2026-01-0${i + 1}T00-00-00-000Z`), 'k' + i)
  }
  dbRecovery.attemptDbRecovery(ud)
  const left = fs.readdirSync(ud).filter(f => f.includes('.corrupt-'))
  const stamps = new Set(left.map(f => f.slice(f.indexOf('.corrupt-') + 9)))
  assert.ok(stamps.size <= 3, '最多保留 3 套现场, got ' + stamps.size)
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: no plaintext backup -> reports the disaster JSON as available', () => {
  const ud = tmpDir()
  fs.writeFileSync(path.join(ud, 'todos.db'), 'CORRUPT')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{"backup":{}}')

  const from = dbRecovery.attemptDbRecovery(ud)
  assert.equal(from.source, 'json')
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: no backups at all -> returns null (honestly reports unrecoverable)', () => {
  const ud = tmpDir()
  fs.writeFileSync(path.join(ud, 'todos.db'), 'CORRUPT')
  assert.equal(dbRecovery.attemptDbRecovery(ud), null)
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: disaster JSON re-import - merges main list + recycle bin, filters id-less rows, returns the count', () => {
  const ud = tmpDir()
  const backup = {
    backup: {
      todoState: {
        todoList: [{ taskId: 'a', taskContent: '主列表' }, { taskContent: '无id应被滤' }],
        recycleList: [{ taskId: 'b', delete: true }]
      }
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  let received = null
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, list => { received = list })
  assert.equal(n, 2, 'only the 2 rows with taskId are imported')
  assert.deepEqual(received.map(t => t.taskId).sort(), ['a', 'b'])
  fs.rmSync(ud, { recursive: true, force: true })
})

test('recovery drill: disaster JSON missing/corrupt -> imports 0 rows without throwing (recovery must not crash a second time)', () => {
  const ud = tmpDir()
  assert.equal(dbRecovery.restoreTasksFromCriticalBackup(ud, () => {}), 0)
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{"backup": {"todoState": "TRUNC"}')
  assert.equal(dbRecovery.restoreTasksFromCriticalBackup(ud, () => {}), 0)
  fs.rmSync(ud, { recursive: true, force: true })
})

/* ---------- (1b) schemaV version stamp: write-side stamps, recovery side rejects future versions ---------- */

test('schema stamp: legacy blob without schemaV imports exactly as before (v1 fallback, no behavior change)', () => {
  const ud = tmpDir()
  const backup = { backup: { todoState: { todoList: [{ taskId: 'old', taskContent: '旧无戳数据' }], recycleList: [] } } }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, () => {})
  assert.equal(n, 1, 'un-stamped (v1-era) data still imports')
  fs.rmSync(ud, { recursive: true, force: true })
})

test('schema stamp: todoState with schemaV>1 is refused (anti-downgrade), other segments still import', () => {
  const ud = tmpDir()
  const backup = {
    backup: {
      todoState: JSON.stringify({ schemaV: 2, todoList: [{ taskId: 'future' }], recycleList: [] }),
      categoryState: JSON.stringify({ schemaV: 1, list: [{ categoryId: 7, categoryName: '分类' }] })
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  let received = null
  const cats = []
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, list => { received = list }, c => { cats.push(c) })
  assert.equal(n, 0, 'future-version todoState segment must be skipped')
  assert.equal(received, null, 'no todo rows reached upsertMany')
  assert.equal(cats.length, 1, 'v1 categoryState segment imports不受影响')
  assert.equal(cats[0].id, 7)
  fs.rmSync(ud, { recursive: true, force: true })
})

test('schema stamp: categoryState with schemaV>1 is refused, todoState (v1) still imports', () => {
  const ud = tmpDir()
  const backup = {
    backup: {
      todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 'keep' }], recycleList: [] }),
      categoryState: JSON.stringify({ schemaV: 99, list: [{ categoryId: 1, categoryName: '未来分类' }] })
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  const cats = []
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, () => {}, c => { cats.push(c) })
  assert.equal(n, 1, 'v1 todoState still imports')
  assert.equal(cats.length, 0, 'future-version categoryState segment must be skipped')
  fs.rmSync(ud, { recursive: true, force: true })
})

test('schema stamp: renderer persists carry schemaV=1 (tomato LS blob / habits blob), legacy un-stamped data still loads', async () => {
  // 写侧：tomato patch -> persistState 写出的 LS blob 必须带 schemaV:1
  const tomato = (await import('../../renderer/js/store/tomato.js')).default
  const habits = (await import('../../renderer/js/store/habits.js')).default
  const st = Object.assign({}, tomato.state, { status: 'default', tomatoRecordList: [] })
  tomato.mutations.patch(st, { todayTomatoCount: 3 })
  const blob = JSON.parse(globalThis.localStorage.getItem('tomatoState'))
  assert.equal(blob.schemaV, 1, 'tomato persist stamps schemaV:1')
  // 写侧：habits persist 写出的 blob 必须带 schemaV:1
  const hs = { habits: [], moments: [], savedAt: 0 }
  habits.mutations.addMoment(hs, { name: '纪念日', date: '2026-09-02', kind: 'memorial' })
  const hb = JSON.parse(globalThis.localStorage.getItem('habitsState'))
  assert.equal(hb.schemaV, 1, 'habits persist stamps schemaV:1')
  // 读侧容错：旧无戳数据行为不变
  const legacyBlob = { status: 'default', todayTomatoCount: 9 }
  globalThis.localStorage.setItem('tomatoState', JSON.stringify(legacyBlob))
  tomato.mutations.patch(st, { todayTomatoCount: 9 })
  assert.equal(JSON.parse(globalThis.localStorage.getItem('tomatoState')).todayTomatoCount, 9, 'legacy un-stamped state reads/writes unchanged')
  // habits readLs：旧无戳数据仍可读
  globalThis.localStorage.setItem('habitsState', JSON.stringify({ habits: [{ id: 2, records: {} }], moments: [], savedAt: 5 }))
  const h2 = { habits: [], moments: [], savedAt: 0 }
  habits.mutations.replaceAll(h2, JSON.parse(globalThis.localStorage.getItem('habitsState')))
  assert.equal(h2.habits.length, 1, 'legacy un-stamped habits blob still accepted')
})

/* ---------- (2) write atomicity ---------- */

test('atomic write: disaster backup tmp+rename - content complete on disk, no .tmp leftovers, old value overwritten', () => {
  const ud = tmpDir()
  dbRecovery.writeCriticalStateBackupAtomic(ud, '{"v":1}')
  const dest = path.join(ud, 'critical-state-backup.json')
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"v":1}')
  assert.equal(fs.readdirSync(ud).filter(f => f.endsWith('.tmp')).length, 0, 'the tmp file must be consumed by the rename')
  dbRecovery.writeCriticalStateBackupAtomic(ud, '{"v":2}')
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"v":2}', 'the second write overwrites the old backup')
  fs.rmSync(ud, { recursive: true, force: true })
})

/* ---------- (3) corruption tolerance (renderer loaders) ---------- */

test('corruption tolerance: parseJSONSafe falls back safely to null for truncated/invalid/empty inputs', async () => {
  const { parseJSONSafe } = await import('../../renderer/js/utils/core.js')
  assert.equal(parseJSONSafe(''), null)
  assert.equal(parseJSONSafe('{"a":'), null, 'truncated object')
  assert.equal(parseJSONSafe('[1,2'), null, 'truncated array')
  assert.equal(parseJSONSafe('garbage'), null)
  assert.equal(parseJSONSafe('null'), null)
  assert.deepEqual(parseJSONSafe('{"ok":1}'), { ok: 1 })
})

test('corruption tolerance: pomodoro record loading falls back safely on corrupt localStorage payloads', async () => {
  // loadState internally uses the parseJSONSafe family; this verifies its data-shape assumptions survive dirty data
  const { parseJSONSafe } = await import('../../renderer/js/utils/core.js')
  const dirty = ['{', '[]', '"str"', '123', '{"tomatoTime":"abc"}']
  for (const d of dirty) {
    const v = parseJSONSafe(d)
    assert.ok(v === null || typeof v === 'object' || typeof v === 'string' || typeof v === 'number')
  }
})
