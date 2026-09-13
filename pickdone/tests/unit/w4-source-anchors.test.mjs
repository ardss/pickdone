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

/** 枚举清单(2026-09-13 收紧:原 `keys.length >= 10` 是恒真型弱断言——注册表被清空到 10 个
 *  也照绿。现与 ANCHORS 实际 keys 集合精确比对;增删 anchor 必须同步改这份清单,防注册表静默漂移。 */
const EXPECTED_ANCHOR_KEYS = [
  'mainIndex', 'mainDir', 'handlersTodo', 'handlersBackup', 'preloadIndex', 'installerNsh',
  'cliLib', 'rendererMain', 'browserShim', 'settingsStore',
  'onboardingVue', 'recycleBinView', 'i18nZhC', 'i18nEnC'
].sort()

test('ANCHORS registry matches the enumerated key set exactly (no silent drift, no depopulation)', () => {
  const keys = Object.keys(ANCHORS).sort()
  assert.deepEqual(keys, EXPECTED_ANCHOR_KEYS,
    'ANCHORS registry drifted from the enumerated set — add/remove the key here deliberately, never silently')
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
