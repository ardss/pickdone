/**
 * maint/dw wave 3 — domain 2 (cross-end data contract + audit single source) regression tests.
 * F-B1 settingsSet blob-family leak (P1) · F-B2 shared reorder scale · F-B3 estimate-core single
 * source · F-B4 buildRenewalInstance · F-B5 normKey NFKC (behavior change) · F-B6 shared audit
 * rotation · F-B7 buffered async audit flush · F-B8 audit content cap (behavior change) +
 * scheduler log privacy.
 * Run: node --test tests/unit/cli/maint-dw3-domain2-contract.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dw3-domain2-'))
const here = path.dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
db.init(process.env.TODO_DB_DIR)

/* ---------- F-B1: settingsSet must not fold habits-family fields into db.settingsState ---------- */

test('F-B1: settingsSet write-back never carries habits/moments/savedAt into the settings blob', () => {
  // Simulate the App's renderer habits persist (whole-blob setMeta → the db-sync bridge mirrors
  // the habits-family fields into the SHARED settings_rows table)
  db.call('setMeta', ['db.habitsState', JSON.stringify({ schemaV: 1, habits: [{ id: 'h1' }], moments: [{ id: 'm1' }], savedAt: Date.now() })])
  const r = lib.settingsSet('colorMode', 'dark')
  assert.equal(r.value, 'dark')
  const blob = JSON.parse(db.call('getMeta', 'db.settingsState'))
  for (const k of ['habits', 'moments', 'savedAt']) {
    assert.ok(!(k in blob), `db.settingsState must not contain habits-family key "${k}" (user-visible: the renderer restores the habits view from this blob)`)
  }
  assert.equal(blob.colorMode, 'dark') // the setting itself still lands
  // the habits blob itself is untouched
  const habits = JSON.parse(db.call('getMeta', 'db.habitsState'))
  assert.equal(habits.habits.length, 1)
})

test('F-B1: the blob _savedAt (bridge LWW gateTs) is the READ moment, not the write moment', () => {
  // Discriminating regression (was a tautology): the race hook fires INSIDE settingsSet between
  // the first settingsDoc() read and the row write — exactly where a sync-apply lands. We inject
  // a settings row stamped 1ms after that moment. Under the OLD write-time stamp the blob's
  // _savedAt (= write moment, after the hook) is NEWER than the injected row and the Round-3
  // stale-echo gate (db-sync-schema putRow: curTs - gateTs > 1000) could never fire for it; under
  // the read-time stamp the row is strictly newer than the blob snapshot.
  lib.setSettingsRaceHookForTests(() => {
    db.call('settingsRowPutMany', [{ key: 'weatherCity', value: 'peer-sync', updatedAt: Date.now() + 1 }])
  })
  try {
    lib.settingsSet('dailyTomatoTarget', '7')
    const blob = JSON.parse(db.call('getMeta', 'db.settingsState'))
    const row = db.call('settingsRowsAll').find(r => r.key === 'weatherCity')
    assert.ok(row && Number.isFinite(row.updatedAt), 'row injected inside the race window landed')
    assert.ok(blob._savedAt < row.updatedAt, 'blob gate stamp must PREDATE a row applied inside the write window (write-time stamping fails this)')
    assert.equal(row.value, 'peer-sync', 'the sync-applied value survives (the blob mirror is value-identical, no re-stamp)')
  } finally {
    lib.setSettingsRaceHookForTests(null)
  }
})

/* ---------- F-B2: shared reorder scale (renderer _writeSort ↔ CLI sortTask) ---------- */

test('F-B2: reorderScale reproduces the 9999→-9999 linear rewrite exactly', async () => {
  const { reorderScale, moveWithin } = await import('../../../shared/sort-core.mjs')
  const scores = reorderScale(4)
  // the previous TodoItem._writeSort inline arithmetic: top=9999, step=2*top/len, fround
  const expected = [0, 1, 2, 3].map(i => Math.fround(9999 - i * (19998 / 4)))
  assert.deepEqual(scores, expected)
  assert.ok(scores[0] > scores[3], 'descending order')
  // moveWithin: midpoint with a beyond row, ±100 margin without
  assert.equal(moveWithin([300, 200, 100], 2, 'up').sort, Math.fround((200 + 300) / 2))
  assert.equal(moveWithin([200, 100], 0, 'up').edge, true, 'up from the top is an edge')
  assert.equal(moveWithin([100, 200], 0, 'down').sort, 300, 'no beyond row → neighbor+100')
  assert.equal(moveWithin([500, 400, 300], 2, 'before', 1).sort, Math.fround((400 + 500) / 2), 'midpoint when a beyond row exists')
  assert.equal(moveWithin([500, 400, 300], 2, 'before', 0).sort, 400, 'no beyond row → ref-100 margin')
})

test('F-B2: CLI sortTask lands midpoints between rows and keeps day order correct', () => {
  const a = lib.addTodo({ content: 'dw3-sortA' })
  const b = lib.addTodo({ content: 'dw3-sortB' })
  const c = lib.addTodo({ content: 'dw3-sortC' })
  lib.sortTask(c.taskId, 'top')
  lib.sortTask(b.taskId, 'after', c.taskId) // b sits between c and a
  const dayOrder = lib.sortTask(a.taskId, 'bottom').dayOrder
  const names = dayOrder.map(s => s.replace('★', ''))
  assert.ok(names.indexOf('dw3-sortC') < names.indexOf('dw3-sortB'), 'c above b')
  assert.ok(names.indexOf('dw3-sortB') < names.indexOf('dw3-sortA'), 'b above a')
  assert.throws(() => lib.sortTask(a.taskId, 'down'), /ALREADY_AT_EDGE|bottom/, 'moving below the bottom edge errors')
})

/* ---------- F-B3: estimate contract single source ---------- */

test('F-B3: shared estimate-core drives the CLI storage contract', async () => {
  const core = await import('../../../shared/estimate-core.mjs')
  assert.equal(core.ESTIMATE_KEY_PREFIX, 'tomatoEstimateState:')
  assert.equal(core.TS_KEY, 'tomatoEstimateStateAt')
  assert.equal(core.LEGACY_KEY, 'tomatoEstimateState')
  assert.equal(core.clampEstimate(25), 20)
  assert.equal(core.clampEstimate(-3), 0)
  assert.equal(core.clampEstimate('7'), 7)
  assert.equal(core.clampEstimate('junk'), 0)
  const t = lib.addTodo({ content: 'dw3-est' })
  lib.setEstimate(t.taskId, 9)
  assert.equal(db.call('getMeta', core.estimateKeyOf(t.taskId)), '9', 'per-task key uses the shared prefix')
  assert.ok(db.call('getMeta', core.TS_KEY) != null, 'shared TS stamp key written')
  assert.equal(lib.getEstimateOf(t.taskId), 9)
})

/* ---------- F-B4: buildRenewalInstance single constructor ---------- */

test('F-B4: buildRenewalInstance carries the renewal field set and bottom-insert sort', () => {
  const t = { taskId: 'src1', userId: 840001, taskContent: 'tpl', taskDescribe: 'd', categoryId: 3, priority: 2, difficulty: 4, subtasks: '[{"text":"s1","checked":true}]' }
  const nt = lib.buildRenewalInstance(t, { todoTime: +new Date('2026-10-01T00:00:00'), reminderTime: 5 }, { estimate: 3 })
  assert.equal(nt.complete, false)
  assert.equal(nt.status, 'add')
  assert.equal(nt.estimate, 3)
  assert.equal(nt.priority, 2)
  assert.equal(nt.difficulty, 4)
  assert.equal(nt.taskContent, 'tpl')
  assert.deepEqual(JSON.parse(nt.subtasks), [{ text: 's1', checked: false }]) // subtask state resets
  assert.equal(nt.reminderTime, 5)
  assert.ok(nt.taskId && nt.taskId !== t.taskId, 'new id generated')
})

test('F-B4: a day whose existing sorts are all exactly 0 still bottom-inserts at -512 (review fix)', () => {
  // nextSort's empty-day check is `!minS && !maxS` — routing min=max=0 through it would wrongly
  // take the 1024 empty-day baseline; the legacy length-keyed branch must produce min-512 = -512.
  const t = lib.addTodo({ content: 'dw3-zero-sorts' })
  lib.patchTodo(t.taskId, { taskSort: 0 }, { action: 'edit' })
  const row = db.call('getById', t.taskId)
  assert.equal(row.taskSort, 0)
  const nt = lib.buildRenewalInstance(row, { todoTime: row.todoTime, reminderTime: 0 }, { estimate: 0 })
  assert.equal(nt.taskSort, -512, 'min(0)-512, NOT the 1024 empty-day baseline')
})

/* ---------- F-B5: normKey single source + NFKC alignment (behavior change) ---------- */

test('F-B5: full-width input resolves the task like the App search does (NFKC)', () => {
  const t = lib.addTodo({ content: 'Ａ１ plan test' }) // full-width A1
  const hit = lib.resolveTask('a1')
  assert.ok(hit && hit.taskId === t.taskId, 'CLI keyword matching must NFKC-fold like renderer search (utils/search.js)')
  assert.equal(lib.normKey('ＡＢｃ'), 'abc')
  assert.equal(lib.normKey('  X\u3000\u200B'), 'x')
})

/* ---------- F-B6: shared non-destructive audit rotation (CLI side) ---------- */

test('F-B6: cli/audit rotates to timestamped archives (no destructive .1) and shares the module with the App', async () => {
  const cliAuditSrc = fs.readFileSync(path.join(here, '../../../cli/audit.js'), 'utf8')
  assert.doesNotMatch(cliAuditSrc, /fs\.unlinkSync/, 'the destructive fixed-.1 unlink must be gone from the CLI (comment mentions allowed)')
  assert.match(cliAuditSrc, /shared\/audit-rotate\.cjs/, 'CLI consumes the shared rotation module')
  const appAuditSrc = fs.readFileSync(path.join(here, '../../../src/main/audit.js'), 'utf8')
  assert.match(appAuditSrc, /shared\/audit-rotate\.cjs/, 'App consumes the same shared rotation module')
  const { rotateArchive } = await import('../../../shared/audit-rotate.cjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dw3-rot-'))
  const file = path.join(tmp, 'cli-audit.jsonl')
  fs.writeFileSync(file, '{"n":1}\n')
  rotateArchive(file)
  const archives = fs.readdirSync(tmp).filter(n => /^cli-audit\.jsonl\.\d+$/.test(n))
  assert.equal(archives.length, 1, 'rolled to a timestamped archive')
  assert.ok(fs.existsSync(file) === false, 'active file moved')
})

/* ---------- F-B7: buffered async audit flush with a durable quit flush ---------- */

test('F-B7: appendEntry buffers (sync read sees nothing until flushNow) and flushNow lands every line', async () => {
  const appAudit = require_('../../../src/main/audit.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dw3-flush-'))
  appAudit.resetForTests()
  appAudit.setDirResolver(() => tmp)
  try {
    appAudit.recordCustom('import', ['x'], [], [], 'buffered-1')
    assert.equal(fs.existsSync(path.join(tmp, 'cli-audit.jsonl')), false, 'write is buffered, not synchronous')
    appAudit.flushNow()
    const lines = fs.readFileSync(path.join(tmp, 'cli-audit.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).note, 'buffered-1')
  } finally {
    appAudit.resetForTests()
  }
})

/* ---------- F-B8: audit content cap + scheduler log privacy ---------- */

test('F-B8: snapshot content fields are capped at 50 chars on disk', async () => {
  const { snapshot } = await import('../../../shared/audit-rotate.cjs')
  const long = 'x'.repeat(120)
  const snap = snapshot({ taskId: 't', taskContent: long, taskDescribe: 'short', updateTime: 1 })
  assert.ok(snap.taskContent.length <= 70, 'capped near 50 chars + marker')
  assert.match(snap.taskContent, /\(120 chars\)$/, 'marker preserves the original length')
  assert.equal(snap.taskDescribe, 'short', 'short content passes through')
  assert.equal(snap.updateTime, 1, 'non-content fields untouched')
})

test('F-B8: scheduler reminder log no longer writes the task title', () => {
  const src = fs.readFileSync(path.join(here, '../../../src/main/scheduler.js'), 'utf8')
  assert.ok(!/\[Reminder\][^\n]*taskContent/.test(src), 'main.log must not receive taskContent (plaintext旁路)')
})

/* ---------- F-B9: settings manifest single source ---------- */

test('F-B9: lib.SETTINGS_MANIFEST is re-exported from shared/settings-manifest.mjs', async () => {
  const { SETTINGS_MANIFEST } = await import('../../../shared/settings-manifest.mjs')
  assert.equal(lib.SETTINGS_MANIFEST, SETTINGS_MANIFEST, 'same object — one source')
  assert.deepEqual(SETTINGS_MANIFEST.ranges.tomatoTime, { min: 5, max: 180 })
})
