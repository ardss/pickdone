/**
 * [w30 P0 supplement] orphan attachment reconciliation (attachment-migrate.js).
 *
 * Real temp dir, real files, three pinned cases:
 *   1. a file referenced by a todo row (image/files JSON) is NEVER an orphan (never deleted);
 *   2. an unreferenced file defaults to AUDIT-ONLY — counted, kept on disk;
 *   3. TODO_CLI_ATTACH_ORPHAN_SWEEP=1 deletes the unreferenced file (and only that one).
 * Bookkeeping names (aliases.json / *.att-tmp-* / *.dtmp) and alias-map entries are never
 * orphans; the audit result is fail-open and never throws.
 *
 * Run: node --test tests/unit/main/w30-attachment-orphan-audit.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Module } from 'node:module'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-att-orphan-'))
const ATT_DIR = path.join(TMP, 'files')
fs.mkdirSync(ATT_DIR, { recursive: true })
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* sweeper fallback */ } })

// Same electron-stub Module._load pattern as attachments-micro-coverage.test.mjs so the lazy
// require('./attachments') fallbacks never pull the real electron.
const ELECTRON_STUB = {
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0-test' },
  protocol: { handle: () => {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const { findOrphanAttachments, reconcileOrphanAttachmentsOnBoot } = await import('../../../src/main/attachment-migrate.js')

const noopLog = { info: () => {}, warn: () => {} }

/** Minimal sqlite-handle stand-in: prepare(...).all() returns injected rows, run() records writes. */
/** Per-test fresh subdir: the sweep test must not see earlier tests' leftover files. */
function freshDir () {
  const d = path.join(ATT_DIR, 'case-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(d, { recursive: true })
  return d
}

function fakeDb (rows) {
  const writes = []
  return {
    writes,
    prepare (sql) {
      return {
        all: () => rows,
        run: (...args) => { writes.push([sql, ...args]) }
      }
    }
  }
}

function rowWithRef (taskId, url) {
  return { id: taskId, taskId, image: JSON.stringify([{ url }]), files: '[]' }
}

test('[w30.4] pure core: referenced file is never an orphan; bookkeeping + aliases are reserved', () => {
  const rows = [rowWithRef('t1', 'local:///' + encodeURIComponent('kept.png'))]
  const orphans = findOrphanAttachments({
    diskNames: ['kept.png', 'ghost.png', 'aliases.json', 'x.att-tmp-123', 'y.dtmp'],
    rows,
    aliases: { 'conflict-key': 'kept.png' }
  })
  assert.deepEqual(orphans, ['ghost.png'], 'only the unreferenced, non-reserved file is an orphan')
})

test('[w30.4] boot audit over a REAL temp dir: referenced file NOT deleted, unreferenced kept by default', () => {
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'referenced.png'), 'a')
  fs.writeFileSync(path.join(dir, 'orphan-default.png'), 'b')
  const db = fakeDb([rowWithRef('t1', 'local:///' + encodeURIComponent('referenced.png'))])
  const r = reconcileOrphanAttachmentsOnBoot(db, {
    attachDirPath: dir,
    listDiskNames: () => fs.readdirSync(dir),
    listAliases: () => ({}),
    log: noopLog,
    sweepEnv: undefined // default: audit only
  })
  assert.equal(r.error, null)
  assert.equal(r.scanned, 2)
  assert.equal(r.orphanCount, 1)
  assert.deepEqual(r.orphans, ['orphan-default.png'])
  assert.equal(r.deleted, 0, 'audit-only: nothing deleted without the env switch')
  assert.ok(fs.existsSync(path.join(dir, 'orphan-default.png')), 'unreferenced file survives the default run')
  assert.ok(fs.existsSync(path.join(dir, 'referenced.png')), 'referenced file survives in every mode')
  assert.ok(db.writes.some(w => String(w[0]).includes('attOrphan.audit')), 'audit stamp lands in meta')
})

test('[w30.4] sweep mode: TODO_CLI_ATTACH_ORPHAN_SWEEP=1 deletes ONLY the unreferenced file', () => {
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'referenced2.png'), 'c')
  fs.writeFileSync(path.join(dir, 'orphan-sweep.png'), 'd')
  const db = fakeDb([rowWithRef('t1', 'local:///' + encodeURIComponent('referenced2.png'))])
  const r = reconcileOrphanAttachmentsOnBoot(db, {
    attachDirPath: dir,
    listDiskNames: () => fs.readdirSync(dir),
    listAliases: () => ({}),
    log: noopLog,
    sweepEnv: '1'
  })
  assert.equal(r.deleted, 1, 'exactly the orphan is swept')
  assert.ok(!fs.existsSync(path.join(dir, 'orphan-sweep.png')), 'ghost file removed')
  assert.ok(fs.existsSync(path.join(dir, 'referenced2.png')), 'referenced file untouched by the sweep')
})

test('[w30.4] alias-reserved and poisoned rows are fail-open: audit never throws', () => {
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'aliased.png'), 'e')
  const db = fakeDb([{ id: 't1', taskId: 't1', image: 'NOT JSON{{{', files: null }])
  const r = reconcileOrphanAttachmentsOnBoot(db, {
    attachDirPath: dir,
    listDiskNames: () => fs.readdirSync(dir),
    listAliases: () => ({ 'some-key': 'aliased.png' }),
    log: noopLog,
    sweepEnv: '1' // sweep on, but the aliased file is reserved → must survive
  })
  assert.equal(r.error, null, 'a poisoned row does not fail the audit (findKeyRefs skips unreadable lists)')
  assert.ok(!r.orphans.includes('aliased.png'), 'alias-map target is never an orphan')
  assert.ok(fs.existsSync(path.join(dir, 'aliased.png')), 'aliased file survives even with the sweep on')
})
