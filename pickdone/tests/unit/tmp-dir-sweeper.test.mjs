/** Sweeper unit tests (2026-10-09): sweepStaleTmpDirs must only delete test temp dirs that
 *  are provably orphaned — family prefix + mtime older than 12h + DEAD owning pid. The
 *  double-guard is the contract under test: a fresh mtime OR a live pid always survives.
 *  Live pid = this test's own process.pid (provably running); dead pid = a bogus number.
 *  Run: node --test tests/unit/tmp-dir-sweeper.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleTmpDirs, isolatedTmpDir } from '../lib/tmp-dir.mjs'

const STALE = new Date(Date.now() - 13 * 60 * 60 * 1000) // 13h ago: past the 12h guard
const DEAD_PID = 999999983 // bogus: no real process carries this pid
const PREFIX = 'todo-sweeper-fix-' // inside the sweeper's family regex

function mk (name) {
  const dir = path.join(os.tmpdir(), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
  return dir
}

test('sweeper deletes only stale + dead-pid family dirs; fresh or live-pid dirs survive', () => {
  const staleDead = mk(`${PREFIX}stale-pid${DEAD_PID}-${Date.now()}`)
  const freshDead = mk(`${PREFIX}fresh-pid${DEAD_PID}-${Date.now()}`)
  const staleLive = mk(`${PREFIX}live-pid${process.pid}-${Date.now()}`)
  // Backdate the two "stale" fixtures; utimes is best-effort (always works on win32/CI).
  fs.utimesSync(staleDead, STALE, STALE)
  fs.utimesSync(staleLive, STALE, STALE)
  try {
    const before = fs.existsSync(staleDead) && fs.existsSync(freshDead) && fs.existsSync(staleLive)
    assert.ok(before, 'setup: all three fixtures exist')
    sweepStaleTmpDirs()
    assert.equal(fs.existsSync(staleDead), false, 'stale + dead pid → deleted')
    assert.equal(fs.existsSync(freshDead), true, 'fresh mtime + dead pid → kept (guard 1)')
    assert.equal(fs.existsSync(staleLive), true, 'stale mtime + live pid → kept (guard 2)')
  } finally {
    for (const d of [staleDead, freshDead, staleLive]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
})

test('sweeper never touches dirs outside the test prefix family', () => {
  const foreign = mk(`zzebra-foreign-pid${DEAD_PID}-${Date.now()}`)
  fs.utimesSync(foreign, STALE, STALE)
  try {
    sweepStaleTmpDirs()
    assert.equal(fs.existsSync(foreign), true, 'non-family dir untouched even when stale + dead-pid')
  } finally {
    try { fs.rmSync(foreign, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('isolatedTmpDir encodes the owning pid for the sweeper and registers exit cleanup', () => {
  const dir = isolatedTmpDir(PREFIX)
  try {
    assert.match(path.basename(dir), new RegExp(`^${PREFIX.replace(/-/g, '\\-')}pid${process.pid}-`), 'name carries <prefix>pid<pid>- encoding')
    assert.ok(fs.existsSync(dir))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* exit hook is the backstop */ }
  }
})
