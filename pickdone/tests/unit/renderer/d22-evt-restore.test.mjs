/**
 * D22 maintenance round (renderer) — tomatoId device-salt regression guards (fix 6).
 * Run: node --test tests/unit/renderer/d22-evt-restore.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [F6] CLI evt-purge snapshot restore ---------- */

test('[F6] applyRestoreDump routes CLI evt dumps (liveRows/purgedRows) to a dedicated branch', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.ok(/!b\.todoState && \(Array\.isArray\(b\.liveRows\) \|\| Array\.isArray\(b\.purgedRows\)\)/.test(src),
    'the evt-segment shape is detected before the stamped-segment path')
  assert.ok(src.includes('applyEvtPurgeDump(b, failed)'), 'the dedicated evt branch is wired in')
})

test('[F6] applyEvtPurgeDump: live rows restored active, purged rows tombstoned, meta whitelisted, honest counts', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  const i = src.indexOf('async applyEvtPurgeDump (b, failed) {')
  assert.ok(i > -1, 'applyEvtPurgeDump exists')
  const body = src.slice(i, i + 1600)
  assert.ok(body.includes('delete: false'), 'liveRows come back as ACTIVE rows')
  assert.ok(body.includes('delete: true'), 'purgedRows stay tombstoned (recycle bin, never revived as active)')
  assert.ok(body.includes("commitCommand('todo', 'putMany'"), 'rows re-put through the shared command door')
  assert.ok(body.includes('META_RESTORE_PREFIXES.some'), 'metaEntries re-put through the same whitelist as metaState')
  assert.ok(body.includes('reportRestoreResult(n, failed)'), 'the report reflects the REAL row count, not a constant zero')
  assert.ok(body.includes("failed.push('evtRows')") && body.includes("failed.push('evtMeta')"), 'per-part failures are reported honestly')
})
