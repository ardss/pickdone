/** W4 self-check for the source-anchor registry (tests/lib/source-anchors.mjs):
 *  every registered anchor must point at a file (or directory, for dir-scan anchors)
 *  that actually exists — catches renames/moves that would otherwise break the
 *  source-anchored test class with confusing ENOENTs instead of a named failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ANCHORS, REPO_ROOT, anchorPath } from '../lib/source-anchors.mjs'

test('ANCHORS registry is non-empty and well-formed', () => {
  const keys = Object.keys(ANCHORS)
  assert.ok(keys.length >= 10, `expected a populated registry, got ${keys.length} entries`)
  for (const [key, rel] of Object.entries(ANCHORS)) {
    assert.equal(typeof rel, 'string', `${key} must map to a string`)
    assert.ok(!path.isAbsolute(rel), `${key} must be repo-root relative`)
    assert.ok(!rel.includes('..'), `${key} must not climb out of the repo root`)
    assert.ok(!rel.includes('\\'), `${key} must use posix separators`)
  }
})

test('every ANCHORS entry exists on disk (file or directory anchors)', () => {
  for (const [key, rel] of Object.entries(ANCHORS)) {
    assert.ok(fs.existsSync(anchorPath(key)), `anchor ${key} -> ${rel} does not exist`)
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'package.json')), 'REPO_ROOT must resolve to the pickdone/ package root')
})
