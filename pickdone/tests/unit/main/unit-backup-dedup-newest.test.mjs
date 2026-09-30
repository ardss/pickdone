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
import { ANCHORS, REPO_ROOT } from '../../lib/source-anchors.mjs'

const require_ = createRequire(import.meta.url)
const fixUtil = require_('../../../src/main/fix-util.js')
// R4 split: the auto-backup dedup block lives in handlers/backup.js (fallback: index.js)
const backupSrcPath = fs.existsSync(path.join(REPO_ROOT, ANCHORS.handlersBackup))
  ? path.join(REPO_ROOT, ANCHORS.handlersBackup)
  : path.join(REPO_ROOT, ANCHORS.mainIndex)
const indexSrc = fs.readFileSync(backupSrcPath, 'utf8')

test('sortBackupNamesNewestFirst puts the newest snapshot first (dedup twin = index 0)', () => {
  const sorted = fixUtil.sortBackupNamesNewestFirst([
    'auto-20260908-100000.json', 'auto-20260910-090000.json', 'evt-meet-20260909-120000.json'
  ])
  assert.equal(sorted[0], 'auto-20260910-090000.json')
  assert.equal(sorted[sorted.length - 1], 'auto-20260908-100000.json')
})

test('backup dedup compares against the newest SAME-TAG twin, never the tail (oldest)', () => {
  const block = indexSrc.slice(
    indexSrc.indexOf('sortBackupNamesNewestFirst(fs.readdirSync(dir)'),
    indexSrc.indexOf('Atomic write: temp file + rename')
  )
  // D11 finding 17: the twin is the newest file of the SAME tag prefix (newestSameTag) — a bare
  // existing[0] compared across tags, letting an evt-* twin suppress an auto-* snapshot whose
  // content point then vanished with the evt tier's rotation. The 2026-09-10 contract (newest,
  // never the tail) is preserved within the tag.
  assert.ok(block.includes('newestSameTag(existing, tag)'), 'dedup must read the newest same-tag twin')
  assert.ok(!block.includes('existing[existing.length - 1]'), 'the tail comparison must stay gone')
  assert.ok(!block.includes("existing[0]"), 'the bare cross-tag existing[0] comparison must stay gone')
})
