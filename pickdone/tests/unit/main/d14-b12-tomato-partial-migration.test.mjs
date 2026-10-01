/* D14 B1+B12 regressions — tomato blob partial-migration replay:
 *   [B1]  a partial-migration RETRY no longer re-applies rows already in tomato_records — the
 *         ON CONFLICT upsert used to UN-TOMBSTONE user-deleted rows (and clobber post-migration
 *         edits) when the whole legacy blob was replayed on the next boot.
 *   [B12] the partial-migration marker carries boot-attempt accounting: attempts increment per
 *         boot, a clean finish clears the attempts key together with the marker — no more
 *         forever-silent re-stamping on permanently rejected rows.
 * Real better-sqlite3 via db.init on fresh temp dirs (d13-sync-db-fixes pattern — never the real
 * %APPDATA% profile). Run: node --test tests/unit/main/d14-b12-tomato-partial-migration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const tomatoOps = require_('../../../src/main/db-tomato-ops.js')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd14-d1-' + label + '-'))
  db.init(dir)
  return dir
}

test('B1: partial-migration retry does not resurrect user-deleted rows', () => {
  freshDevice('b1')
  const now = Date.now()
  const blob = {
    tomatoRecordList: [
      { tomatoId: 'd14b1-a', endTime: now, focus: 'a', focusDuration: 5 },
      { tomatoId: 'd14b1-b', endTime: now, focus: 'b', focusDuration: 5 },
      { tomatoId: 'd14b1-c', endTime: now, focus: 'c', focusDuration: 5 },
    ],
  }
  db.call('setMeta', ['db.tomatoState', JSON.stringify(blob)])
  // Force the per-row rejection the marker exists for (d13 pattern): row '-c' is rejected
  // (in production: a corrupt row shape), '-a'/'-b' take the REAL insert path so the
  // resurrection scenario below exercises the true upsert behavior.
  const origAppend = tomatoOps.tomatoAppendMany
  const stubbed = (d, rows) => {
    const list = Array.isArray(rows) ? rows : [rows]
    const res = origAppend(d, list.filter(r => !String(r && r.tomatoId).endsWith('-c')))
    return { accepted: res.accepted, rejected: list.map((r, i) => ({ index: i, tomatoId: String(r.tomatoId), reason: 'stubbed permanent rejection' })).filter(x => x.tomatoId.endsWith('-c')) }
  }
  tomatoOps.tomatoAppendMany = stubbed
  try {
    // run 1: A+B accepted, C rejected → marker set, blob kept
    const n1 = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n1, 2)
    assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), '1', 'run 1: partial marker set')
    // user deletes A after boot 1
    const removed = db.call('tomatoRemoveByIds', ['d14b1-a'])
    assert.deepEqual(removed, ['d14b1-a'])
    // run 2 (boot 2): the retry re-runs the blob — A must STAY deleted
    const n2 = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n2, 0, 'run 2: A/B already present, only the bad row is (re)rejected')
    assert.equal(db.call('tomatoGetById', 'd14b1-a'), null, 'A still reads as deleted')
    assert.ok(db.call('tomatoTombstones', []).some(t => t.tomatoId === 'd14b1-a'), 'A tombstone survives the retry (red before the fix: the ON CONFLICT upsert un-tombstoned it)')
    assert.equal(db.call('tomatoGetById', 'd14b1-b').tomatoId, 'd14b1-b', 'B untouched')
    assert.ok(db.call('getMeta', 'db.tomatoState'), 'blob kept: the rejected row has no other copy')
  } finally { tomatoOps.tomatoAppendMany = origAppend }
  db.close()
})

test('B12: partial-migration attempts are accounted and clear on completion', () => {
  freshDevice('b12')
  const origAppend = tomatoOps.tomatoAppendMany
  tomatoOps.tomatoAppendMany = () => ({ accepted: 0, rejected: [{ index: 0, tomatoId: 'd14b12-x', reason: 'stubbed permanent rejection' }] })
  try {
    db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [{ tomatoId: 'd14b12-x', endTime: Date.now(), focus: 'x', focusDuration: 1 }] })])
    db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigrationAttempts'), '1', 'attempt 1 counted')
    db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigrationAttempts'), '2', 'attempt 2 counted (before: re-stamped forever with zero accounting)')
  } finally { tomatoOps.tomatoAppendMany = origAppend }
  // repair the blob → full acceptance clears BOTH the marker and the attempts key
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [{ tomatoId: 'd14b12-ok', endTime: Date.now(), focus: 'ok', focusDuration: 1 }] })])
  const n = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
  assert.equal(n, 1)
  assert.equal(db.call('getMeta', 'db.tomatoState'), null)
  assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), null)
  assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigrationAttempts'), null, 'attempts key cleared with the marker')
  db.close()
})
