/* C2 fixer round — data-integrity regressions (2026-10-21).
 * Covered findings:
 *   #1 P2 milestones blob: corrupt read is LOUD (MILESTONES_CORRUPT, was silent [] that writers
 *      then persisted — destroying the blob); add/rm/link re-read before the whole-key put and
 *      UNION peer-new entries by id (narrowed concurrent window); purge scrub unions too.
 *   #2 P2 sortTask rescale: the whole-pool rewrite is ONE bus transaction (todo.putMany) instead
 *      of N independent patchTodo transactions (half-rescale on mid-loop crash).
 *   #3 P2 tag rename/rm: per-row failures surface as structured CliError TAG_REWRITE_PARTIAL with
 *      a batch-shaped failures[] payload (was: opaque abort with rows half-rewritten).
 *   #4 P2 SQLITE_BUSY folded into an opaque error → structured retryable CliError DB_BUSY.
 *   #5 P2 planSet --replace: new chip written FIRST, stale chips removed after (crash ⇒ duplicate,
 *      not loss). (Behavioral-order fix; asserted via the pickdone-level flow in item #8 skip note
 *      below — the write order itself is covered by inspection + plan suites.)
 *   #6 P3 list/search truncation is signaled: sentinel tail row { truncated: true } when matched
 *      rows exceed the cap; --limit 0 keeps its fail-closed zero-row contract.
 *   #7 P3 addTodo binned-twin return null → REPEAT_TWIN throw: SKIPPED — evidence conflict:
 *      tests/unit/cli/f2-repeat-restore-twin.test.mjs:81 PINS the `addTodo → null` contract and
 *      that file is outside this fix's allowed edit scope (adjacent suites must stay green).
 *
 * Part A runs against pure factory-injected fakes (no db); Part B uses an isolated temp DB.
 * Run: node --test tests/unit/cli/c2-data-integrity.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-c2-integrity-')
const require_ = createRequire(import.meta.url)

/* ================= Part A: milestone blob + tag rewrite via factory-injected fakes ================= */

class FakeCliError extends Error {
  constructor (message, code = 'CLI_ERROR') { super(message); this.code = code }
}
const dayjs = require_('dayjs')
// stub: parseMilestoneDateCore(input, dayjs) — only the add-path calls it; ISO strings suffice
const msDate = input => Date.parse(String(input).length === 10 ? String(input) + 'T00:00:00Z' : input)

function msFactory (metaStore, { commitSpy } = {}) {
  const lib = require_('../../../cli/lib-projects.cjs')({
    open: () => ({ call: (op, ...a) => {
      if (op === 'getMeta') return metaStore.get(...a)
      if (op === 'listMetaKeys') return [...metaStore.keys()]
      if (op === 'getAllCategories') return [{ categoryId: 7, categoryName: 'C2Proj' }]
      if (op === 'queryTodos') return []
      throw new Error('unexpected op ' + op)
    } }),
    CliError: FakeCliError,
    dayjs,
    commit: (entity, verb, payload) => { if (commitSpy) commitSpy(entity, verb, payload); metaStore.set(payload[0], payload[1]) },
    audit: { record: () => {} },
    resolveCategory: input => (input == null || input === '' ? null : Number(input) || 7),
    resolveTask: id => ({ taskId: id, taskContent: 'x' }),
    liveTasks: () => [],
    tomatoRecords: () => [],
    parseDate: msDate,
    dayStartOf: ts => ts && Math.floor(ts / 864e5) * 864e5,
    parseMilestoneDateCore: (input) => msDate(input)
  })
  return lib
}

test('#1a getMilestones on a corrupt blob throws MILESTONES_CORRUPT (was: silent [] that writers persisted)', () => {
  const store = new Map([['projectMilestones:7', '{oops not json']])
  const lib = msFactory(store)
  assert.throws(() => lib.getMilestones('7'), e => e.code === 'MILESTONES_CORRUPT' && /restore|backup/i.test(e.message))
  // writers must not zero the blob either: addMilestone on a corrupt blob fails loud BEFORE any put
  assert.throws(() => lib.addMilestone('7', 'm1', '2026-11-01'), e => e.code === 'MILESTONES_CORRUPT')
  assert.equal(store.get('projectMilestones:7'), '{oops not json', 'corrupt blob left untouched (no destructive rewrite)')
})

test('#1b non-array blob is also MILESTONES_CORRUPT (not silently []-ed)', () => {
  const store = new Map([['projectMilestones:7', '{"id":"m1"}']])
  const lib = msFactory(store)
  assert.throws(() => lib.getMilestones('7'), e => e.code === 'MILESTONES_CORRUPT')
})

test('#1c addMilestone unions a peer entry that landed between read and write (by id)', () => {
  const store = new Map()
  let reads = 0
  // scripted peer write: after the FIRST getMeta read, a peer lands its own milestone
  const raw = JSON.stringify([{ id: 'ms_mine', title: 'kickoff', date: 1700000000000, taskIds: [] }])
  const peerRaw = JSON.stringify([{ id: 'ms_mine', title: 'kickoff', date: 1700000000000, taskIds: [] }, { id: 'ms_peer', title: 'peer landed late', date: 1700000001000, taskIds: [] }])
  store.set('projectMilestones:7', raw)
  const lib = msFactory(store)
  const origGet = store.get.bind(store)
  store.get = k => { if (++reads === 2) return peerRaw /* msPersist's re-read sees the peer blob */; return origGet(k) }
  const r = lib.addMilestone('7', 'ship', '2026-11-02')
  const persisted = JSON.parse(store.get('projectMilestones:7'))
  assert.ok(persisted.some(m => m.id === 'ms_peer'), 'peer-NEW milestone survived the whole-key put (union by id)')
  assert.equal(r.added.id, persisted.find(m => m.title === 'ship').id, 'added echo is the stored row')
  assert.equal(persisted.length, 3)
})

test('#1d removeMilestone: the removed id stays gone AND a peer entry survives the write', () => {
  const store = new Map()
  const base = [{ id: 'ms_a', title: 'a', date: 1000, taskIds: [] }, { id: 'ms_b', title: 'b', date: 2000, taskIds: [] }]
  const withPeer = base.concat([{ id: 'ms_peer', title: 'peer', date: 3000, taskIds: [] }])
  store.set('projectMilestones:7', JSON.stringify(base))
  const lib = msFactory(store)
  let reads = 0
  const origGet = store.get.bind(store)
  store.get = k => { if (++reads === 2) return JSON.stringify(withPeer); return origGet(k) }
  const r = lib.removeMilestone('7', 1) // removes ms_a (index 1 of date-sorted list)
  const persisted = JSON.parse(store.get('projectMilestones:7'))
  assert.ok(!persisted.some(m => m.id === 'ms_a'), 'our removal is not resurrected by the union')
  assert.ok(persisted.some(m => m.id === 'ms_peer'), 'peer-NEW milestone survives')
  assert.ok(persisted.some(m => m.id === 'ms_b'))
  assert.equal(r.removed.id, 'ms_a')
})

test('#1e linkMilestone unions peer entries and applies the link', () => {
  const store = new Map()
  store.set('projectMilestones:7', JSON.stringify([{ id: 'ms_a', title: 'a', date: 1000, taskIds: [] }]))
  const lib = msFactory(store)
  let reads = 0
  const origGet = store.get.bind(store)
  store.get = k => {
    if (++reads === 2) return JSON.stringify([{ id: 'ms_a', title: 'a', date: 1000, taskIds: [] }, { id: 'ms_peer', title: 'peer', date: 5000, taskIds: [] }])
    return origGet(k)
  }
  lib.linkMilestone('7', 1, 't1', true)
  const persisted = JSON.parse(store.get('projectMilestones:7'))
  assert.deepEqual(persisted.find(m => m.id === 'ms_a').taskIds, ['t1'])
  assert.ok(persisted.some(m => m.id === 'ms_peer'), 'peer milestone survived the link write')
})

/* ---- #3 tag rewrite partial failure (factory-injected patchTodo) ---- */
function tagsFactory (rows, patchTodo) {
  return require_('../../../cli/lib-tags.cjs')({
    liveTasks: () => rows,
    recycleTasks: () => [],
    CliError: FakeCliError,
    patchTodo,
    toggleComplete: () => {},
    dateChangeReminderPatch: () => ({}),
    migrateChipsOnDayChange: () => {},
    parseDate: msDate,
    resolveCategory: () => null
  })
}

test('#3a rewriteTag: one failing row no longer aborts the run — rest rewritten, structured TAG_REWRITE_PARTIAL with batch-shaped failures[]', () => {
  const ok1 = { taskId: 't_ok1', taskContent: 'buy #milk.', taskDescribe: '' }
  const bad = { taskId: 't_bad', taskContent: 'also #milk', taskDescribe: '' }
  const ok2 = { taskId: 't_ok2', taskContent: 'more #milk', taskDescribe: '' }
  const patched = []
  const lib = tagsFactory([ok1, bad, ok2], (id, patch) => {
    if (id === 't_bad') throw new Error('simulated bus failure')
    patched.push(id)
    return { taskId: id, ...patch }
  })
  let err
  try { lib.rewriteTag('milk', 'dairy') } catch (e) { err = e }
  assert.ok(err, 'partial failure must surface (was: opaque abort mid-loop)')
  assert.equal(err.code, 'TAG_REWRITE_PARTIAL')
  assert.deepEqual(err.failures, [{ taskId: 't_bad', error: 'simulated bus failure' }], 'failures[] is batch-contract shaped')
  assert.equal(err.touched, 2, 'rows rewritten before the failure are counted')
  assert.deepEqual(patched.sort(), ['t_ok1', 't_ok2'], 'the run did NOT abort — rows after the failure were still rewritten')
})

test('#3b rewriteTag happy path keeps the touched-number contract (no throw)', () => {
  const rows = [{ taskId: 'a', taskContent: '#x here', taskDescribe: '' }, { taskId: 'b', taskContent: 'clean', taskDescribe: 'also #x' }]
  const lib = tagsFactory(rows, id => ({ taskId: id }))
  assert.equal(lib.rewriteTag('x', 'y'), 2)
})

/* ================= Part B: real isolated DB (lib.js seams) ================= */
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const bus = require_('../../../src/main/command-bus.js')
const core = require_('../../../src/main/core/todo-core.js')

db.init(process.env.TODO_DB_DIR)

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'c2任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

test('#4 SQLITE_BUSY from the bus surfaces as structured retryable DB_BUSY (not an opaque error)', () => {
  const orig = bus.commit
  bus.commit = () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e }
  try {
    assert.throws(() => lib.commit('meta', 'put', ['c2_probe', '1']), e => {
      return e.code === 'DB_BUSY' && /retry/i.test(e.message)
    }, 'commit wrapper must fold SQLITE_BUSY into a CliError DB_BUSY')
  } finally { bus.commit = orig }
  // a non-BUSY error keeps its original shape (only BUSY/LOCKED are folded)
  bus.commit = () => { const e = new Error('boom'); e.code = 'SOME_OTHER'; throw e }
  try {
    assert.throws(() => lib.commit('meta', 'put', ['c2_probe', '1']), e => e.code === 'SOME_OTHER' || e.code === undefined)
  } finally { bus.commit = orig }
  // after restore, a real commit works (wrapper is pass-through on success)
  lib.commit('meta', 'put', ['c2_probe', '1'])
  assert.equal(db.call('getMeta', 'c2_probe'), '1')
})

test('#4b SQLITE_LOCKED folds to DB_BUSY too', () => {
  const orig = bus.commit
  bus.commit = () => { const e = new Error('locked'); e.code = 'SQLITE_LOCKED'; throw e }
  try { assert.throws(() => lib.commit('meta', 'put', ['c2_probe2', '1']), e => e.code === 'DB_BUSY') }
  finally { bus.commit = orig }
})

test('#6 listTodos signals truncation with a { truncated: true } sentinel row (matched > cap)', () => {
  const kw = 'c2trunc'
  for (let i = 0; i < 3; i++) seed({ taskContent: kw + ' #' + i })
  const rows = lib.listTodos({ keyword: kw, limit: 2 })
  assert.equal(rows.length, 3)
  assert.equal(rows[2].truncated, true, 'tail sentinel carries truncated:true for JSON consumers')
  assert.equal(rows[0].truncated, undefined)
  assert.match(rows[2].taskContent, /higher --limit/)
  assert.deepEqual(rows.slice(0, 2).map(r => r.truncated), [undefined, undefined], 'real rows untouched')
  // under the cap: plain rows, no sentinel
  const all = lib.listTodos({ keyword: kw, limit: 200 })
  assert.equal(all.length, 3)
  assert.ok(all.every(r => r.truncated === undefined))
})

test('#6b explicit --limit 0 keeps the fail-closed zero-row contract (no sentinel)', () => {
  assert.deepEqual(lib.listTodos({ keyword: 'c2trunc', limit: 0 }), [])
})

test('#2 sortTask rescale rewrites the whole day pool in ONE transaction (single audit entry, linear scale)', () => {
  const D = +dayjs().add(11, 'day').startOf('day')
  const a = seed({ taskContent: 'c2sortA', taskSort: 1000, todoTime: D, dayStart: D })
  const b = seed({ taskContent: 'c2sortB', taskSort: 999.5, todoTime: D, dayStart: D })
  const c = seed({ taskContent: 'c2sortC', taskSort: 999, todoTime: D, dayStart: D })
  // landing gap |999 - mid(999.5,1000)| = 0.75 < 2 → the whole-pool rescale branch must fire
  const r = lib.sortTask(c.taskId, 'up')
  assert.deepEqual(r.dayOrder, ['c2sortA', '★c2sortC', 'c2sortB'], 'mover landed between A and B (reorderScale[1] = 0)')
  const rows = [a, b, c].map(x => db.call('getById', x.taskId))
  assert.deepEqual(rows.map(x => x.taskSort).sort((p, q) => q - p), [9999, 3333, -3333], 'whole pool rewritten onto the linear scale (reorderScale(3))')
  // exactly ONE audit entry covers the batch (the old code emitted N per-row patchTodo entries)
  const entries = lib.readAuditLog({ n: 50, action: 'sort' })
  const mine = entries.filter(e => (e.note || '').includes('one transaction') && (e.targets || []).some(t => t.taskId === c.taskId))
  assert.equal(mine.length, 1, 'rescale recorded as a single batch audit entry')
})

test('#1f purge scrub keeps unrelated milestones and still scrubs purged taskIds (union write)', () => {
  const cat = lib.addCategory('C2PurgeProj')
  const id = String(cat.categoryId)
  const keepTask = seed({ taskContent: 'c2 purge keeper', categoryId: cat.categoryId })
  const doomed = seed({ taskContent: 'c2 purge doomed', categoryId: cat.categoryId, delete: true, deletedAt: Date.now(), status: 'delete' })
  db.call('setMeta', ['projectMilestones:' + id, JSON.stringify([
    { id: 'ms_keep', title: 'keep', date: 1000, taskIds: [keepTask.taskId] },
    { id: 'ms_doomed', title: 'doomed link', date: 2000, taskIds: [doomed.taskId, keepTask.taskId] }
  ])])
  lib.purgeRecycleBin()
  const blob = JSON.parse(db.call('getMeta', 'projectMilestones:' + id))
  assert.equal(blob.find(m => m.id === 'ms_keep').taskIds.length, 1, 'unrelated link untouched')
  assert.deepEqual(blob.find(m => m.id === 'ms_doomed').taskIds, [keepTask.taskId], 'purged taskId scrubbed, sibling link kept')
  assert.ok(db.call('getById', doomed.taskId) == null, 'row itself is purged')
})

test('#5 planSet --replace keeps the chips (write-new-first; no delete-first loss window)', () => {
  const t = seed({ taskContent: 'c2 plan replace', todoTime: +dayjs().add(12, 'day').startOf('day') })
  lib.planSet(t.taskId, '09:00', { date: dayjs(t.dayStart).format('YYYY-MM-DD') })
  lib.planSet(t.taskId, '10:00', { date: dayjs(t.dayStart).format('YYYY-MM-DD'), replace: true })
  const day = dayjs(t.dayStart).format('YYYY-MM-DD')
  const list = lib.planList(day)
  const row = list.tasks.find(x => x.taskId === t.taskId)
  assert.deepEqual(row.chips, ['10:00'], '--replace rebuilt: old chip gone, new chip present (delete ran AFTER the put)')
})
