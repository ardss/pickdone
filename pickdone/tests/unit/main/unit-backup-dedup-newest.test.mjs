/** Regression for review P1 (2026-09-10): the backup content-dedup sorted snapshots newest-first but
 *  compared against the array TAIL — i.e. the OLDEST file. Dedup therefore never fired in the common
 *  case, and a stale snapshot could be returned as "the" backup. The comparison now targets existing[0].
 *  The dedup call site lives inline in src/main/index.js (quit-time/backup path, not unit-instantiable),
 *  so the fix is pinned source-level plus a behavioral pin of the shared sort helper. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const fixUtil = require_('../../../src/main/fix-util.js')
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..')
const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')

test('sortBackupNamesNewestFirst puts the newest snapshot first (dedup twin = index 0)', () => {
  const sorted = fixUtil.sortBackupNamesNewestFirst([
    'auto-20260908-100000.json', 'auto-20260910-090000.json', 'evt-meet-20260909-120000.json'
  ])
  assert.equal(sorted[0], 'auto-20260910-090000.json')
  assert.equal(sorted[sorted.length - 1], 'auto-20260908-100000.json')
})

test('backup dedup compares against existing[0] (newest), never the tail (oldest)', () => {
  const block = indexSrc.slice(
    indexSrc.indexOf('sortBackupNamesNewestFirst(fs.readdirSync(dir)'),
    indexSrc.indexOf('Atomic write: temp file + rename')
  )
  assert.ok(block.includes('existing[0]'), 'dedup must read existing[0]')
  assert.ok(!block.includes('existing[existing.length - 1]'), 'the tail comparison must stay gone')
})
