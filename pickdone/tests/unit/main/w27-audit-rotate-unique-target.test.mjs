/* W27 maintenance round — fix 5 (P3): shared/audit-rotate.cjs cross-process rotate TOCTOU.
 * The old `while (fs.existsSync(rolled)) rolled = ...` probe is not atomic ACROSS processes:
 * two writers (App + CLI rotate the SAME cli-audit.jsonl, SOP-08) can both probe the same
 * `<ms>` target as free before either renames — POSIX rename silently overwrites, destroying
 * one writer's multi-MB archive. The target is now unique BY CONSTRUCTION:
 * `<file>.<ms><pid><seq>`, digits-only so pruneArchives' /^\d+$/ filter still matches.
 * Run: node --test tests/unit/main/w27-audit-rotate-unique-target.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { rotateArchive } = require('../../../shared/audit-rotate.cjs')

const noop = () => {}
const mk = tag => fs.mkdtempSync(path.join(os.tmpdir(), 'w27-rot-' + tag + '-'))

test('W27 fix 5a: two rotations under a FROZEN clock never collide or overwrite', () => {
  const dir = mk('frozen')
  const file = path.join(dir, 'cli-audit.jsonl')
  // freeze the clock: the OLD name scheme would probe the exact same `<file>.<T>` target on
  // both calls (the cross-process race, collapsed into one process for determinism).
  const realNow = Date.now
  Date.now = () => 1700000000000
  try {
    fs.writeFileSync(file, 'archive-one')
    const r1 = rotateArchive(file, noop)
    fs.writeFileSync(file, 'archive-two')
    const r2 = rotateArchive(file, noop)
    assert.notEqual(r1, r2, 'same-ms rotations must land on distinct targets')
    assert.equal(fs.readFileSync(r1, 'utf8'), 'archive-one', 'first archive intact (was overwritten by rename races before)')
    assert.equal(fs.readFileSync(r2, 'utf8'), 'archive-two', 'second archive intact')
    const suffixOf = r => path.basename(r).slice('cli-audit.jsonl.'.length)
    assert.match(suffixOf(r1), /^\d+$/, 'suffix stays digit-only for pruneArchives')
    assert.match(suffixOf(r2), /^\d+$/, 'suffix stays digit-only for pruneArchives')
    assert.ok(path.basename(r1).includes(String(process.pid)), 'target embeds the pid — two processes cannot mint the same name')
  } finally {
    Date.now = realNow
  }
})

test('W27 fix 5b: a sibling that already claimed the plain <ms> name survives the rotation untouched', () => {
  const dir = mk('sibling')
  const file = path.join(dir, 'cli-audit.jsonl')
  // simulate the other writer having JUST renamed its archive into the name this process is
  // about to probe (the race window of the old existsSync→renameSync pair)
  const realNow = Date.now
  Date.now = () => 1700000000000
  try {
    const claimed = file + '.1700000000000'
    fs.writeFileSync(claimed, 'sibling-archive')
    fs.writeFileSync(file, 'mine')
    const rolled = rotateArchive(file, noop)
    assert.notEqual(rolled, claimed, 'rotation must not land on the claimed name')
    assert.equal(fs.readFileSync(claimed, 'utf8'), 'sibling-archive', 'the other writer\'s archive is NOT overwritten')
    assert.equal(fs.readFileSync(rolled, 'utf8'), 'mine', 'our archive landed intact')
  } finally {
    Date.now = realNow
  }
})

test('W27 fix 5c: pid-suffixed archives participate in pruning (newest kept, oldest pruned)', () => {
  const dir = mk('prune')
  const file = path.join(dir, 'cli-audit.jsonl')
  // six archives with increasing numeric suffixes (pid embedded, same scheme as the fix)
  const names = []
  for (let i = 1; i <= 6; i++) {
    const n = file + '.' + (1700000000000 + i) + process.pid + i
    fs.writeFileSync(n, 'arch-' + i)
    names.push(n)
  }
  fs.writeFileSync(file, 'current')
  const rolled = rotateArchive(file, noop)
  assert.ok(rolled, 'rotation succeeded')
  const kept = fs.readdirSync(dir).sort()
  assert.equal(kept.length, 4, 'prune keeps 4 newest (incl. the fresh rotation)')
  for (const gone of names.slice(0, 3)) {
    assert.equal(fs.existsSync(gone), false, 'oldest pruned: ' + path.basename(gone))
  }
  for (const keptName of names.slice(3)) {
    assert.equal(fs.existsSync(keptName), true, 'newest kept: ' + path.basename(keptName))
  }
})
