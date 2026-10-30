/**
 * ANCHOR_SETS negative + equivalence tests (GPT-adjudicated P1 green-light criteria):
 * missing key, empty set, duplicate entries, path escapes, dangling file, and
 * byte-for-byte equivalence with the legacy hand-built concatenation.
 * All fault fixtures are injected into the live ANCHOR_SETS object and reverted in
 * finally — nothing here touches real anchors or real files.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ANCHOR_SETS, REPO_ROOT, anchorSetPaths, readAnchorSet } from '../../lib/source-anchors.mjs'

/** Inject a bad set, run fn, always revert. */
function withBadSet (key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(ANCHOR_SETS, key)
  const prev = ANCHOR_SETS[key]
  ANCHOR_SETS[key] = value
  try { fn() } finally {
    if (had) ANCHOR_SETS[key] = prev
    else delete ANCHOR_SETS[key]
  }
}

test('anchorSetPaths: unknown key throws and names the known sets', () => {
  assert.throws(() => anchorSetPaths('noSuchSet'), /unknown source anchor set: noSuchSet .*settingsStoreFamily/)
})

test('anchorSetPaths: empty set throws', () => {
  withBadSet('badEmpty', [], () => {
    assert.throws(() => anchorSetPaths('badEmpty'), /non-empty array/)
  })
})

test('anchorSetPaths: duplicate entries throw', () => {
  withBadSet('badDup', ['src/main/db.js', 'src/main/db.js'], () => {
    assert.throws(() => anchorSetPaths('badDup'), /duplicate entry: src\/main\/db\.js/)
  })
})

test('anchorSetPaths: absolute paths and .. escapes throw', () => {
  withBadSet('badAbs', ['C:\\evil\\payload.js'], () => {
    assert.throws(() => anchorSetPaths('badAbs'), /repo-relative without '\.\.' escapes/)
  })
  withBadSet('badEsc', ['renderer/../secrets.txt'], () => {
    assert.throws(() => anchorSetPaths('badEsc'), /repo-relative without '\.\.' escapes/)
  })
})

test('anchorSetPaths: non-string entries throw', () => {
  withBadSet('badType', [42], () => {
    assert.throws(() => anchorSetPaths('badType'), /non-string\/empty entry/)
  })
})

test('readAnchorSet: dangling file throws naming the key and the path', () => {
  withBadSet('badDangle', ['src/main/definitely-not-here.js'], () => {
    assert.throws(() => readAnchorSet('badDangle'),
      /anchor set badDangle references a missing file.*without updating ANCHOR_SETS/s)
  })
})

test('readAnchorSet output is byte-identical to the legacy hand-built concatenation', () => {
  // the very concatenation this registry replaced, spelled out longhand:
  const legacy = fs.readFileSync(path.join(REPO_ROOT, 'src/main/db-schema.js'), 'utf8') +
    '\n' + fs.readFileSync(path.join(REPO_ROOT, 'src/main/db.js'), 'utf8')
  assert.equal(readAnchorSet('dbSchemaFamily'), legacy,
    'registry output must match the old manual join exactly (order + separator)')
})

test('every ANCHOR_SETS entry resolves and exists on disk (no silent rot)', () => {
  for (const [key, set] of Object.entries(ANCHOR_SETS)) {
    const paths = anchorSetPaths(key)
    assert.equal(paths.length, set.length, key + ' resolution count mismatch')
    for (const p of paths) {
      assert.ok(fs.existsSync(p), `${key} -> ${p} does not exist — a split/move landed without updating ANCHOR_SETS`)
    }
  }
})
