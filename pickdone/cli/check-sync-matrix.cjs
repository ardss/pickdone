#!/usr/bin/env node
'use strict'
/**
 * Sync-matrix contract gate: docs/sync-matrix.md ↔ the code's actual sync surface.
 *
 * The matrix doc is the hand-audited sync coverage contract. Nothing previously verified that
 * the code still matches it — an entity could silently drop out of sync coverage (bug class
 * seen in past waves). This gate cross-checks, both directions:
 *
 *   1. Every entity the doc lists as syncable (§3 round kinds) must still exist in the code's
 *      authoritative registry: SYNCABLE_ENTITIES in src/main/sync-apply-hydrate.js (the apply pipeline's
 *      egress/ingress allowlist).
 *   2. Every code entity must appear in the doc — UNKNOWN = ERROR, forcing the doc to be updated
 *      in the same commit that adds a syncable entity.
 *   3. The command manifest (src/main/command-manifest.js, the write-surface registry the
 *      command-bus wave created) must agree: every sync:'full' command's entity must be
 *      SYNCABLE, every SYNCABLE entity must have at least one sync:'full' command, and no
 *      sync:'local' entity may be SYNCABLE (machine-local entities never egress).
 *   4. DATA_CHANNEL_KINDS (src/main/lan-sync-bootstrap.js) must match the doc's §3 declaration
 *      and stay a subset of the syncable entities.
 *
 * Dependency-free except command-manifest.js (which is deliberately loadable outside electron —
 * sync-apply-hydrate.js itself requires electron-log, so its SYNCABLE_ENTITIES set is extracted by
 * source parse, same technique the other static gates use).
 *
 * Env overrides for red-proof fixtures:
 *   SYNC_MATRIX_DOC  — path to the matrix doc (default <repo>/docs/sync-matrix.md)
 *   SYNC_MATRIX_ROOT — repo root holding src/ and docs/ (default the pickdone root)
 */

const fs = require('fs')
const path = require('path')

const ROOT = process.env.SYNC_MATRIX_ROOT ||
  path.dirname(path.dirname(__filename))
// Doc default is anchored to THIS file's repo, not SYNC_MATRIX_ROOT — the root override exists
// for code-side fixtures whose temp tree has no docs/.
const DOC = process.env.SYNC_MATRIX_DOC ||
  path.join(path.dirname(path.dirname(__filename)), 'docs', 'sync-matrix.md')

const errors = []
const fail = msg => errors.push(msg)

// ── doc side ────────────────────────────────────────────────────────────────
const docText = fs.readFileSync(DOC, 'utf8')
const docLines = docText.split(/\r?\n/)

// §3 round kinds: the first line inside the "## 3." section that is a bare
// backtick-identifier list (`todo`, `setting`, ...).
const sec3 = docLines.findIndex(l => /^##\s+3\./.test(l))
if (sec3 < 0) fail('doc: cannot find the "## 3." round-kinds section')
let docEntities = []
for (let i = sec3 + 1; i < docLines.length; i++) {
  const l = docLines[i]
  if (/^##\s/.test(l)) break // ran into the next section without finding the list
  if (/^`[A-Za-z][A-Za-z0-9]*`(\s*,\s*`[A-Za-z][A-Za-z0-9]*`)*\s*$/.test(l)) {
    docEntities = [...l.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map(m => m[1])
    break
  }
}
if (!docEntities.length) fail('doc: cannot parse the §3 round-kinds entity list (expected a bare `a`, `b`, ... line)')

// §3 DATA_CHANNEL_KINDS declaration
// The doc may wrap the declaration in a backtick span (`DATA_CHANNEL_KINDS = [...]`) — strip
// backticks so both inline-code and bare shapes parse.
const docKindLine = docLines.find(l => /DATA_CHANNEL_KINDS\s*=/.test(l))
const docKinds = docKindLine
  ? (docKindLine.replace(/`/g, '').match(/DATA_CHANNEL_KINDS\s*=\s*\[([^\]]*)\]/) || [])[1]
  : null
const docKindsList = docKinds
  ? [...docKinds.matchAll(/['"`]([A-Za-z][A-Za-z0-9]*)['"`]/g)].map(m => m[1])
  : []
if (!docKindsList.length) fail('doc: cannot parse the §3 DATA_CHANNEL_KINDS declaration')

// ── code side ───────────────────────────────────────────────────────────────
// SYNCABLE_ENTITIES from src/main/sync-apply-hydrate.js (source parse — the module pulls electron-log).
const applySrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'sync-apply-hydrate.js'), 'utf8')
const mSyncable = applySrc.match(/SYNCABLE_ENTITIES\s*=\s*new Set\(\[([^\]]*)\]\)/)
const codeEntities = mSyncable
  ? [...mSyncable[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map(m => m[1])
  : []
if (!codeEntities.length) fail('code: cannot parse SYNCABLE_ENTITIES from src/main/sync-apply-hydrate.js')

// DATA_CHANNEL_KINDS from src/main/lan-sync-bootstrap.js
const bootSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'lan-sync-bootstrap.js'), 'utf8')
const mKinds = bootSrc.match(/DATA_CHANNEL_KINDS\s*=\s*\[([^\]]*)\]/)
const codeKindsList = mKinds
  ? [...mKinds[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map(m => m[1])
  : []
if (!codeKindsList.length) fail('code: cannot parse DATA_CHANNEL_KINDS from src/main/lan-sync-bootstrap.js')

// Command manifest — dependency-free by contract, safe to require here. Always loaded from
// THIS repo (its relative shared/ import breaks under a SYNC_MATRIX_ROOT fixture tree; the
// code-side fixtures only vary the source-parsed sync-apply-hydrate.js anyway).
let manifest
try {
  manifest = require(path.join(path.dirname(path.dirname(__filename)), 'src', 'main', 'command-manifest.js'))
} catch (e) {
  fail('code: cannot load src/main/command-manifest.js: ' + e.message)
  manifest = { COMMANDS: {} }
}
const fullEntities = new Set()
const localEntities = new Set()
for (const row of Object.values(manifest.COMMANDS)) {
  if (row.sync === 'full') fullEntities.add(row.entity)
  else if (row.sync === 'local') localEntities.add(row.entity)
}

// ── cross-checks ────────────────────────────────────────────────────────────
// 1. doc → code: every matrix entity's sync path must still exist.
for (const e of docEntities) {
  if (!codeEntities.includes(e)) fail(`doc→code: matrix entity "${e}" (docs/sync-matrix.md §3) has no SYNCABLE_ENTITIES entry in src/main/sync-apply-hydrate.js — the sync path was dropped or renamed without updating the contract`)
}
// 2. code → doc: unknown entity = error (forces the doc update in the same commit).
for (const e of codeEntities) {
  if (!docEntities.includes(e)) fail(`code→doc: syncable entity "${e}" (sync-apply-hydrate.js SYNCABLE_ENTITIES) is missing from docs/sync-matrix.md §3 — update the matrix doc in the same commit`)
}
// 3. manifest ↔ SYNCABLE_ENTITIES agreement.
for (const e of fullEntities) {
  if (!codeEntities.includes(e)) fail(`manifest→code: command-manifest.js has sync:'full' commands for entity "${e}" but it is not in SYNCABLE_ENTITIES (sync-apply-hydrate.js) — rows of this entity will pass the bus yet never egress/ingress`)
}
for (const e of codeEntities) {
  if (!fullEntities.has(e)) fail(`code→manifest: syncable entity "${e}" (SYNCABLE_ENTITIES) has no sync:'full' command row in command-manifest.js — its write surface left the bus census`)
}
for (const e of localEntities) {
  if (codeEntities.includes(e)) fail(`manifest→code: entity "${e}" is sync:'local' (machine-local) in command-manifest.js but IS in SYNCABLE_ENTITIES — a machine-local entity must never be syncable`)
}
// 4. DATA_CHANNEL_KINDS: doc declaration must match code, and stay syncable.
for (const k of docKindsList) {
  if (!codeKindsList.includes(k)) fail(`doc→code: DATA_CHANNEL_KINDS member "${k}" declared in the matrix doc is absent from lan-sync-bootstrap.js`)
}
for (const k of codeKindsList) {
  if (!docKindsList.includes(k)) fail(`code→doc: DATA_CHANNEL_KINDS member "${k}" (lan-sync-bootstrap.js) is not declared in the matrix doc §3`)
}
for (const k of codeKindsList) {
  if (!codeEntities.includes(k)) fail(`code: DATA_CHANNEL_KINDS member "${k}" is not a SYNCABLE entity — the broadcast would announce kinds the engine never emits`)
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`[check-sync-matrix] doc entities: [${docEntities.join(', ')}]`)
console.log(`[check-sync-matrix] code SYNCABLE_ENTITIES: [${codeEntities.join(', ')}]`)
console.log(`[check-sync-matrix] manifest full-sync entities: [${[...fullEntities].sort().join(', ')}]; local entities: [${[...localEntities].sort().join(', ')}]`)
console.log(`[check-sync-matrix] DATA_CHANNEL_KINDS doc=[${docKindsList.join(', ')}] code=[${codeKindsList.join(', ')}]`)
if (errors.length) {
  for (const e of errors) console.error('[check-sync-matrix] ✗ ' + e)
  console.error(`[check-sync-matrix] ${errors.length} drift finding(s) — docs/sync-matrix.md and the code sync surface disagree`)
  process.exit(1)
}
console.log('[check-sync-matrix] ✓ matrix doc and code sync surface agree (' + docEntities.length + ' entities, ' + codeKindsList.length + ' channel kinds)')
