/* W29 (P3) — ownAppVersion must not permanently cache a failed first read.
 *
 * The version cache used to pin '' when the first package.json read failed, so every
 * subsequent hello broadcast advertised an empty version forever. A failed read is not a
 * value: the cache is left untouched so the next call retries.
 *
 * Run: node --test tests/unit/lan-sync/w29-own-app-version-retry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const transport = require(path.join(ROOT, 'src', 'main', 'lan-sync', 'transport.js'))
const { ownAppVersion, __resetOwnAppVersionForTests } = transport

test('w29: a failed first version read is NOT cached — the next call retries', () => {
  __resetOwnAppVersionForTests()
  let calls = 0
  const flaky = () => { calls++; if (calls === 1) throw new Error('w29 transient read failure'); return '9.9.9-w29' }
  // first read fails: returns '' but must NOT pin the empty string
  assert.equal(ownAppVersion(flaky), '')
  // second call retries and succeeds
  assert.equal(ownAppVersion(flaky), '9.9.9-w29', 'RED before the fix: the empty string was cached forever')
  assert.equal(calls, 2, 'the failed read did not consume the cache slot')
})

test('w29: a successful read stays cached (no repeated loader calls)', () => {
  __resetOwnAppVersionForTests()
  let calls = 0
  const good = () => { calls++; return '1.2.3-w29' }
  assert.equal(ownAppVersion(good), '1.2.3-w29')
  assert.equal(ownAppVersion(good), '1.2.3-w29')
  assert.equal(calls, 1, 'the successful value is cached')
})

test('w29: the default loader serves package.json version', () => {
  __resetOwnAppVersionForTests()
  const v = ownAppVersion()
  assert.ok(v && v.length > 0, 'default loader resolves the app version, got: ' + JSON.stringify(v))
})
