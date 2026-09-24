/**
 * dw audit-wam domain (2026-09-25) — audit no-op suppression, fail-safe default dir, rotation EPERM robustness.
 *  1. appendEntry folds CONSECUTIVE identical changes:[] records (the category.upsert ×N storm shape) into
 *     one line with a repeat count; records WITH changes are never folded.
 *  2. The default dir resolver refuses the real %APPDATA% when running outside Electron with no isolation
 *     env (latent write path to the real library from any non-Electron require of src/main/audit.js).
 *  3. rotateArchive survives Windows EPERM (dual-writer holds the handle): retry+backoff → .corrupt-<ts>
 *     fallback → truncate, never silent.
 * Run: node --test tests/unit/main/dw-audit-wam-rotate-fixes.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appAudit = require('../../../src/main/audit.js')
const { rotateArchive } = require('../../../shared/audit-rotate.cjs')

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-wam-test-'))
  appAudit.setDirResolver(() => tmpDir)
})

afterEach(() => {
  appAudit.resetForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readLines () {
  appAudit.flushNow()
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

test('[audit-wam] consecutive identical changes:[] records fold into ONE line with a repeat count', () => {
  // The storm shape: the same category re-upserted round after round → identical (action, argv, targets)
  for (let i = 0; i < 5; i++) appAudit.recordAppOp('upsertCategory', { id: 'c1', name: 'Work', color: '#000' })
  // A different category is a DIFFERENT line; a real edit (changes present) is never folded
  appAudit.recordAppOp('upsertCategory', { id: 'c2', name: 'Study', color: '#111' })
  appAudit.recordAppOp('upsertCategory', { id: 'c1', name: 'Work', color: '#000' })
  appAudit.recordAppOp('upsert', { taskId: 't1', taskContent: 'x' }, { before: { taskId: 't1', taskContent: 'x' } })

  const lines = readLines()
  assert.equal(lines.length, 4, '5 identical no-ops → 1 line; distinct payloads keep their own lines')
  assert.equal(lines[0].action, 'category.upsert')
  assert.equal(lines[0].repeat, 5, 'the fold carries how many identical writes happened')
  assert.match(lines[0].note, /×5/)
  assert.equal(lines[1].repeat, 1)
  assert.equal(lines[2].targets[0].taskId, 'cat:c1')
  assert.equal(lines[2].repeat, 1)
  assert.equal('repeat' in lines[3], false, 'records WITH changes are never folded')
})

test('[audit-wam] non-Electron without isolation env refuses the real %APPDATA% audit dir (fail-safe)', async t => {
  const saved = { db: process.env.TODO_DB_DIR, udd: process.env.TODO_USER_DATA_DIR }
  delete process.env.TODO_DB_DIR
  delete process.env.TODO_USER_DATA_DIR
  t.after(() => { if (saved.db != null) process.env.TODO_DB_DIR = saved.db; if (saved.udd != null) process.env.TODO_USER_DATA_DIR = saved.udd })

  appAudit.resetForTests() // resolver back to the DEFAULT (userDataDir) chain — no injection
  assert.equal(appAudit.auditFile(), null, 'refused resolver hands out no path')
  assert.doesNotThrow(() => { appAudit.recordAppOp('upsertCategory', { id: 'x', name: 'n' }); appAudit.flushNow() })
  appAudit.resetForTests()
})

test('[audit-wam] rotateArchive retries through transient EPERM (dual-writer handle) and rotates normally', () => {
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  fs.writeFileSync(file, '{"line":1}\n')
  const realRename = fs.renameSync
  let calls = 0
  fs.renameSync = (a, b) => { if (++calls <= 2) { const e = new Error('EPERM: resource busy'); e.code = 'EPERM'; throw e } return realRename(a, b) }
  const warnings = []
  try {
    const rolled = rotateArchive(file, m => warnings.push(m))
    assert.ok(/^\d+$/.test(path.basename(rolled).slice('cli-audit.jsonl.'.length)), 'rotated to a timestamped archive after retries')
    assert.equal(fs.existsSync(file), false, 'main file moved — threshold respected')
    assert.deepEqual(warnings, [], 'transient EPERM needs no warning once the retry lands')
  } finally { fs.renameSync = realRename }
})

test('[audit-wam] rotateArchive never fails silent: persistent EPERM falls back to .corrupt-<ts> with a warning', () => {
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  fs.writeFileSync(file, '{"line":1}\n')
  const realRename = fs.renameSync
  const realTruncate = fs.truncateSync
  fs.renameSync = (a, b) => { if (!String(b).includes('.corrupt-')) { const e = new Error('EPERM: resource busy'); e.code = 'EPERM'; throw e } return realRename(a, b) }
  const warnings = []
  try {
    const out = rotateArchive(file, m => warnings.push(m))
    assert.match(out, /\.corrupt-/, 'fallback target is the marked .corrupt-<ts> name')
    assert.equal(fs.existsSync(file), false, 'oversized file is out of the way — a fresh trail starts')
    assert.equal(warnings.length, 1, 'exactly one non-silent warning')
    assert.match(warnings[0], /corrupt|rename/i)
  } finally { fs.renameSync = realRename; fs.truncateSync = realTruncate }
})

test('[audit-wam] folded entries SEAL on flush: records after a drain start a fresh line, none are lost', () => {
  // Adversarial repro (2026-09-25): 1 write → flushNow → 50 identical writes → flushNow used to land
  // ONE line with repeat=1 — the 50 post-flush records only mutated the detached entry object and were
  // dropped. Every flush window's fold count must reach disk.
  appAudit.recordAppOp('upsertCategory', { id: 'c1', name: 'Work', color: '#000' })
  appAudit.flushNow()
  for (let i = 0; i < 50; i++) appAudit.recordAppOp('upsertCategory', { id: 'c1', name: 'Work', color: '#000' })
  appAudit.flushNow()

  const lines = readLines()
  assert.equal(lines.length, 2, 'two flush windows → two lines')
  assert.equal(lines[0].repeat, 1)
  assert.equal(lines[1].repeat, 50, 'the post-flush window folds among itself')
  assert.equal(lines.reduce((s, l) => s + (l.repeat || 1), 0), 51, 'on-disk fold counts sum to every record written')
})

test('[audit-wam] successful rotation prunes STALE .corrupt- siblings (bounded), keeps fresh ones', () => {
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  fs.writeFileSync(file, '{"line":1}\n')
  const stale = file + '.corrupt-2020-01-01T00-00-00-000Z'
  const fresh = file + '.corrupt-2026-09-25T00-00-00-000Z'
  fs.writeFileSync(stale, 'old oversized copy')
  fs.writeFileSync(fresh, 'recent oversized copy')
  const old = new Date('2020-01-01')
  fs.utimesSync(stale, old, old)
  fs.utimesSync(fresh, new Date(), new Date())
  rotateArchive(file, () => {})
  assert.equal(fs.existsSync(stale), false, 'corrupt sibling older than the keep window is cleaned on rotation')
  assert.ok(fs.existsSync(fresh), 'fresh corrupt sibling is kept')
  assert.ok(fs.readdirSync(tmpDir).some(n => /^cli-audit\.jsonl\.\d+$/.test(n)), 'rotation itself still happened')
})

test('[audit-wam] rotateArchive last resort: rename AND corrupt-rename both fail → truncate + warn, never throw', () => {
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  fs.writeFileSync(file, 'x'.repeat(100))
  const realRename = fs.renameSync
  const realTruncate = fs.truncateSync
  fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
  fs.truncateSync = f => realTruncate(f, 0)
  const warnings = []
  try {
    const out = rotateArchive(file, m => warnings.push(m))
    assert.equal(out, undefined)
    assert.equal(fs.statSync(file).size, 0, 'main file truncated back under the threshold')
    assert.equal(warnings.length, 1, 'truncation is announced, never silent')
  } finally { fs.renameSync = realRename; fs.truncateSync = realTruncate }
})
