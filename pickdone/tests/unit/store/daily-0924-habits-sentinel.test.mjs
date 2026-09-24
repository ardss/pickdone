/* B7 (daily 2026-09-24): habits.initFromDb reuses dbMirror's DB_MIRROR_ERROR sentinel —
 * F-C4 parity with the settings store. The old inline getMeta + silent catch collapsed
 * "DB read FAILED" into "no mirror", leaving stale LS state in place for the next persist()
 * to drown the (newer) durable DB copy. Now a read error warns and skips the cycle.
 * Run: node --test tests/unit/store/daily-0924-habits-sentinel.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + Math.random())

function withTodoAPI (api) {
  globalThis.window.todoAPI = { ...(globalThis.window.todoAPI || {}), ...api }
}

test('B7: a DB read ERROR skips the restore cycle (sentinel path) instead of behaving like "no mirror"', async () => {
  const habits = await importSrc('renderer/js/store/habits.js')
  const dbCalls = []
  withTodoAPI({
    dbCall: (op, key) => { dbCalls.push({ op, key }); return Promise.reject(new Error('injected transient getMeta failure')) },
  })
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => { warns.push(a.join(' ')) }
  try {
    // must RESOLVE (not throw) and must NOT attempt any write-back
    await habits.default.actions.initFromDb({ commit: () => { throw new Error('replaceAll must not run on a read error') } })
  } finally {
    console.warn = origWarn
  }
  assert.ok(dbCalls.some(c => c.op === 'getMeta' && c.key === 'db.habitsState'), 'the DB mirror was read')
  assert.ok(warns.some(w => w.includes('[habits] initFromDb')), 'the read failure is WARNED (not silently swallowed)')
})

test('B7: an unparseable DB blob is treated as a read error too (no replaceAll, no migration write)', async () => {
  const habits = await importSrc('renderer/js/store/habits.js')
  withTodoAPI({ dbCall: () => Promise.resolve('not-json{{{') })
  const commits = []
  await habits.default.actions.initFromDb({ commit: (mut, blob) => commits.push({ mut, blob }) })
  assert.equal(commits.length, 0, 'garbage blob must not reach replaceAll')
})

test('B7: a healthy DB mirror still restores (positive control, incl. the legacy-key migration)', async () => {
  const habits = await importSrc('renderer/js/store/habits.js')
  const blob = { schemaV: 1, habits: [{ id: 'h1', name: 'walk', records: {} }], moments: [], savedAt: 500 }
  withTodoAPI({ dbCall: (op, key) => Promise.resolve(key === 'db.habitsState' ? null : JSON.stringify(blob)) })
  const commits = []
  const ctx = {
    commit: (mut, payload) => commits.push({ mut, payload }),
  }
  // capture the legacy copy write through the command bus seam: habits.js calls commitCommand
  // ('meta','put') -> utils/commandBus -> window.todoAPI; observe via a dbCall spy on setMeta.
  const dbCalls = []
  withTodoAPI({
    dbCall: (op, key) => {
      dbCalls.push({ op, key })
      return Promise.resolve(op === 'getMeta' && key === 'db.habitsState' ? null : (op === 'getMeta' ? JSON.stringify(blob) : true))
    },
  })
  await habits.default.actions.initFromDb(ctx)
  assert.deepEqual(commits.map(c => c.mut), ['replaceAll'])
  assert.equal(commits[0].payload.habits[0].id, 'h1')
  assert.ok(dbCalls.some(c => c.op === 'setMeta'), 'legacy blob was copied to the db.-prefixed key')
})
