/**
 * r4 main-domain fixes (2026-09-28), four regressions:
 *  1. db.js call(): when oplogEntriesFor throws (outside appendOplog's try/catch), the delta loss
 *     is now routed through db-oplog's shared reportAppendFailure — the oplogStats counter AND the
 *     onAppendFailure hook (→ 'oplog-append-failed' syncEvent) fire for BOTH entry points.
 *     Before: log.warn only, invisible to oplogStats/Device Center.
 *  2. lan-sync-bootstrap syncEvent enum doc: set-equality against every emitSyncEvent('<type>')
 *     site in src/ (18 types) — no more substring-only gating that let the doc fall behind.
 *  3. db-meta-gc deleteSnowDedupKeysFor: prefix upper bound `key < prefix + ';'` missed any
 *     dedupKey whose first byte >= 0x3B (e.g. 'focus-1'); now substr prefix equality (red-before:
 *     a letter-led dedup key survived hardDelete).
 *  4. handlers/csv-import: IMPORT_MAX_OUTSTANDING / IMPORT_MAX_LEAKED are file-private consts
 *     again — the dead module.exports surface is gone.
 * Run: node --test tests/unit/main/fix-20260928-r4-main.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const oplogFactory = require('../../../src/main/db-oplog.js')
const db = require('../../../src/main/db.js')
const csvImport = require('../../../src/main/handlers/csv-import.js')

/* ---------- 1. oplogEntriesFor-throw failures share the reporter ---------- */

test('r4-1: reportAppendFailure increments oplogStats and fires the hook (shared entry point)', () => {
  const failures = []
  const mod = oplogFactory({
    getDb: () => { throw new Error('unused') },
    log: { warn () {}, info () {}, error () {} },
    onAppendFailure: info => failures.push(info),
  })
  const before = mod.oplogStats().appendFailures
  mod.reportAppendFailure('entries build blew up')
  assert.equal(mod.oplogStats().appendFailures, before + 1, 'the SAME counter appendOplog uses')
  assert.equal(failures.length, 1, 'the hook fires for the entries-build entry point too')
  assert.equal(failures[0].error, 'entries build blew up')
  assert.equal(failures[0].count, before + 1)
})

test('r4-1: db.js routes the oplogEntriesFor-throw catch into reportAppendFailure', () => {
  const src = read('src/main/db.js')
  assert.match(src, /catch \(e\) \{ oplog\.reportAppendFailure\(e && e\.message\) \}/,
    'call() must use the shared reporter, not a bare log.warn')
  assert.doesNotMatch(src, /oplog capture failed \(write itself is unaffected\)/,
    'the log-only failure exit is gone')
})

/* ---------- 2. syncEvent type enum doc == emitted set ---------- */

test('r4-2: every emitted syncEvent type is documented, and the doc lists nothing unemitted', () => {
  // actual emit set (same extraction the ask ran): every emitSyncEvent('<type>') literal in src/
  const emitted = new Set()
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.m?js$/.test(f.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/emitSyncEvent\('([a-z-]+)'/g)) emitted.add(m[1])
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  assert.ok(emitted.size >= 18, 'sanity: the emit corpus is intact (got ' + emitted.size + ')')

  const bootSrc = read('src/main/lan-sync-bootstrap.js')
  const typesDoc = bootSrc.slice(bootSrc.indexOf('Types:'), bootSrc.indexOf('function emitSyncEvent'))
  // only pure token lines count (comma-separated type lists); prose lines are ignored
  const documented = new Set()
  for (const m of typesDoc.matchAll(/^ \* ([a-z][a-z-]*(?:, [a-z][a-z-]*)+)[.,]?\s*$/gm)) {
    for (const t of m[1].split(/,\s*/)) documented.add(t)
  }

  for (const t of emitted) assert.ok(documented.has(t), 'undocumented emitted type: ' + t)
  for (const t of documented) assert.ok(emitted.has(t), 'documented type that is never emitted: ' + t)
  assert.equal(documented.size, emitted.size, 'set equality (no drift in either direction)')
})

/* ---------- 3. snowDedup GC covers non-numeric dedup keys ---------- */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r4-snowdedup-'))

test('r4-3: hardDelete GCs snowDedup keys with a letter-led dedupKey (red before the fix)', () => {
  const dir = tmp()
  db.init(dir)
  try {
    db.call('upsert', { taskId: 'sd_t1', taskContent: 'task one' })
    db.call('setMeta', ['snowDedup:sd_t1:focus-1', '1']) // first byte 'f' (0x66) >= 0x3B — escaped the old upper bound
    db.call('setMeta', ['snowDedup:sd_t1:1727500000000', '1']) // numeric-led key — always matched
    assert.equal(db.call('getMeta', 'snowDedup:sd_t1:focus-1'), '1', 'precondition: key present')
    db.call('hardDelete', 'sd_t1')
    assert.equal(db.call('getMeta', 'snowDedup:sd_t1:focus-1'), null, 'letter-led dedup key dies with the task')
    assert.equal(db.call('getMeta', 'snowDedup:sd_t1:1727500000000'), null, 'numeric-led dedup key still dies')
  } finally { db.close() }
})

test('r4-3: the delete is prefix-exact — another task ids keys survive (no over-delete)', () => {
  const dir = tmp()
  db.init(dir)
  try {
    db.call('upsert', { taskId: 'sd_a', taskContent: 'a' })
    db.call('upsert', { taskId: 'sd_ab', taskContent: 'ab' })
    db.call('setMeta', ['snowDedup:sd_a:focus-1', '1'])
    db.call('setMeta', ['snowDedup:sd_ab:z-9', '1'])
    db.call('hardDelete', 'sd_a')
    assert.equal(db.call('getMeta', 'snowDedup:sd_ab:z-9'), '1', 'sibling-prefix task keys are untouched')
    // renderer-supplied id with LIKE wildcards must not widen the delete
    db.call('upsert', { taskId: 'sd_%', taskContent: 'pct' })
    db.call('setMeta', ['snowDedup:sd_%:x', '1'])
    db.call('setMeta', ['snowDedup:sd_q:y', '1'])
    db.call('hardDelete', 'sd_%')
    assert.equal(db.call('getMeta', 'snowDedup:sd_%:x'), null, 'wildcard id deletes its own keys exactly')
    assert.equal(db.call('getMeta', 'snowDedup:sd_q:y'), '1', 'a LIKE-widened sibling key survives')
  } finally { db.close() }
})

/* ---------- 4. dead export surface removed ---------- */

test('r4-4: csv-import no longer exports IMPORT_MAX_OUTSTANDING / IMPORT_MAX_LEAKED', () => {
  assert.equal(csvImport.IMPORT_MAX_OUTSTANDING, undefined, 'dead export removed from the public surface')
  assert.equal(csvImport.IMPORT_MAX_LEAKED, undefined, 'dead export removed from the public surface')
  const src = read('src/main/handlers/csv-import.js')
  assert.match(src, /^const IMPORT_MAX_OUTSTANDING = /m, 'the cap stays as a file-private const')
  assert.match(src, /^const IMPORT_MAX_LEAKED = /m, 'the cap stays as a file-private const')
  assert.ok(!/module\.exports\.IMPORT_MAX/.test(src), 'no module.exports attachment remains')
})
