/**
 * W31 P2 — attachmentId 显式化 (explicit attachment identity).
 *
 * Incident shape: a Chinese filename AND its case-twin both sit on disk. Chromium
 * lowercases the HOST of a legacy host-form url, so BOTH rows' urls decode to the SAME
 * lowercased basename; the W29 migration's disk reverse-lookup sees the case-twin pair as
 * ambiguous and marks each entry `missing: true` (the W17 "refusing to guess" doctrine).
 * From that moment the two entries are indistinguishable by basename:
 * attachments.findKeyRefs('中文.png', rows) hits BOTH rows — the delete-guard/orphan
 * audit counts one entry as a reference to the OTHER twin's bytes (误伤).
 *
 * Fix (this slice): the migration stamps every rewritten entry with a UNIQUE
 * `attachmentId`; findKeyRefs matches id-carrying entries by id, and a missing-marked
 * id-carrying entry is no longer counted by basename (so the twin is not hit). Legacy
 * entries without an id keep the exact-basename rules (F2 shared-ref guard unchanged),
 * and cleanly-resolved id-carrying entries still basename-match so deleting a file
 * shared by two rows stays guarded.
 *
 * Run: node --test tests/unit/main/w31-attachment-id.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)) // pickdone/

const M = require(join(ROOT, 'src/main/attachment-migrate.js'))
const attachments = require(join(ROOT, 'src/main/attachments.js'))

/** Deterministic id factory injected into the migration so ids are assertable. */
const makeIdFactory = () => { let n = 0; return () => 'att-id-' + (++n) }

const legacyUrl = name => 'local://' + encodeURIComponent(name) // host form (no third slash)

test('migration: chinese case-twin rows — each entry gets a unique attachmentId; ambiguous twins stay missing', () => {
  // Disk holds BOTH case twins — the reverse-lookup cannot disambiguate a lowercased host key.
  const diskNames = ['中文.png', '中文.PNG']
  const rows = {
    r1: { id: 'r1', image: JSON.stringify([{ name: '中文.png', url: legacyUrl('中文.png') }]), files: '[]' },
    r2: { id: 'r2', image: JSON.stringify([{ name: '中文.PNG', url: legacyUrl('中文.PNG') }]), files: '[]' }
  }
  const ids = makeIdFactory() // one factory across rows, mirroring the boot entry
  const out1 = M.migrateRowAttachments(rows.r1, { diskNames, idFactory: ids })
  const out2 = M.migrateRowAttachments(rows.r2, { diskNames, idFactory: ids })

  const e1 = JSON.parse(out1.image)[0]
  const e2 = JSON.parse(out2.image)[0]
  assert.ok(e1.attachmentId, 'row r1 entry carries an attachmentId after migration')
  assert.ok(e2.attachmentId, 'row r2 entry carries an attachmentId after migration')
  assert.notEqual(e1.attachmentId, e2.attachmentId, 'the twin entries must get DISTINCT ids')
  assert.equal(e1.missing, true, 'ambiguous twin stays missing (W17 doctrine unchanged)')
  assert.equal(e2.missing, true, 'ambiguous twin stays missing (W17 doctrine unchanged)')
})

test('findKeyRefs: hits by attachmentId and does NOT hit the case-twin (basename误伤 fixed)', () => {
  const diskNames = ['中文.png', '中文.PNG']
  const mk = (taskId, attId, url) => ({ taskId, image: JSON.stringify([{ url, attachmentId: attId, missing: true }]), files: '[]' })
  const r1 = mk('r1', 'att-id-1', legacyUrl('中文.png'))
  const r2 = mk('r2', 'att-id-2', legacyUrl('中文.PNG'))

  // By id: exactly its own row — the twin is never dragged in.
  assert.deepEqual(attachments.findKeyRefs('att-id-1', [r1, r2]), [{ taskId: 'r1', field: 'image' }])
  assert.deepEqual(attachments.findKeyRefs('att-id-2', [r1, r2]), [{ taskId: 'r2', field: 'image' }])

  // By basename (what both legacy urls decode to): the old code hit BOTH rows here.
  const hits = attachments.findKeyRefs('中文.png', [r1, r2])
  assert.equal(hits.length, 0, 'a missing-marked id-carrying entry is not counted by basename — the twin误伤 is gone')
})

test('findKeyRefs: legacy entries (no id) keep exact-basename matching; resolved id-carrying entries keep the F2 shared-ref guard', () => {
  // Legacy rows without attachmentId: basename rules unchanged (F2 contract).
  const legacyA = { taskId: 'a', image: JSON.stringify([{ url: 'local:///a.png' }]), files: '[]' }
  const legacyB = { taskId: 'b', files: JSON.stringify([{ url: 'local:///' + encodeURIComponent('a.png') }]), image: '[]' }
  assert.equal(attachments.findKeyRefs('a.png', [legacyA, legacyB]).length, 2, 'legacy basename refs still counted')

  // Cleanly-resolved entries carry ids but still basename-match: two rows sharing one
  // real file must both guard its unlink (the original F2 bug).
  const sharedUrl = 'local:///' + encodeURIComponent('shared.png')
  const rowA = { taskId: 'a', image: JSON.stringify([{ url: sharedUrl, attachmentId: 'att-id-x' }]), files: '[]' }
  const rowB = { taskId: 'b', image: JSON.stringify([{ url: sharedUrl, attachmentId: 'att-id-y' }]), files: '[]' }
  assert.equal(attachments.findKeyRefs('shared.png', [rowA, rowB]).length, 2, 'resolved shared ref still guarded by basename')
  assert.deepEqual(attachments.findKeyRefs('att-id-x', [rowA, rowB]), [{ taskId: 'a', field: 'image' }],
    'by id, only its own row is counted — the other row sharing the file is not误伤')
})

test('migration idempotency: ids are stable — a second pass rewrites nothing and mints no new ids', () => {
  const diskNames = ['中文.png', '中文.PNG']
  let n = 0
  const idFactory = () => 'att-id-' + (++n)
  const row = { id: 'r1', image: JSON.stringify([{ name: 'x', url: legacyUrl('中文.png') }]), files: '[]' }
  const first = M.migrateRowAttachments(row, { diskNames, idFactory })
  assert.equal(n, 1, 'one id minted on the first pass')
  const persisted = { id: 'r1', image: first.image, files: first.files }
  const second = M.migrateRowAttachments(persisted, { diskNames, idFactory })
  assert.equal(second.changed, false, 'second pass is a no-op')
  assert.equal(n, 1, 'no new id minted on the second pass')
  assert.equal(JSON.parse(second.image)[0].attachmentId, 'att-id-1', 'the first-pass id is preserved verbatim')
})
