/** D10 (2026-09-27): hardDelete/hardDeleteMany must GC `tomatoEstimateState:<taskId>` inside the
 *  delete transaction. Sync/manifest-issued hard deletes bypass the renderer purgeIds path (which
 *  calls setEstimate(id,0)), so the estimate meta row used to leak until the next startup MetaGC.
 * Run: node --test tests/unit/main/d10-harddelete-estimate-gc.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../../../src/main/db.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'd10-est-gc-'))

test('d10: hardDelete removes tomatoEstimateState:<id> in the same transaction', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'est_t1', taskContent: 'task one' })
  db.call('setMeta', ['tomatoEstimateState:est_t1', '25'])
  assert.equal(db.call('getMeta', 'tomatoEstimateState:est_t1'), '25')
  db.call('hardDelete', 'est_t1')
  assert.equal(db.call('getMeta', 'tomatoEstimateState:est_t1'), null, 'estimate meta dies with the row (red before the fix: leaked)')
})

test('d10: hardDeleteMany removes tomatoEstimateState:<id> for every id', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'est_t2', taskContent: 'task two' })
  db.call('upsert', { taskId: 'est_t3', taskContent: 'task three' })
  db.call('setMeta', ['tomatoEstimateState:est_t2', '10'])
  db.call('setMeta', ['tomatoEstimateState:est_t3', '20'])
  db.call('hardDeleteMany', ['est_t2', 'est_t3'])
  assert.equal(db.call('getMeta', 'tomatoEstimateState:est_t2'), null)
  assert.equal(db.call('getMeta', 'tomatoEstimateState:est_t3'), null)
})

test('d10: purgeRecycleBin GCs the estimate keys of purged rows (same lifecycle rule)', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'est_t4', taskContent: 'recycled', delete: 1 }) // recycle-bin row (renderer field shape: `delete`, db-rows maps it to the deleted column)
  db.call('setMeta', ['tomatoEstimateState:est_t4', '5'])
  const purged = db.call('purgeRecycleBin')
  assert.ok(purged.includes('est_t4'))
  assert.equal(db.call('getMeta', 'tomatoEstimateState:est_t4'), null)
})
