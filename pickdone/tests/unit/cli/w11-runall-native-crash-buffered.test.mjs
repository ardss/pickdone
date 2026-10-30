/* W11 run-all native-crash retry buffering (2026-10-26) — source contract pin.
 * The native-crash retry rerun was spawned LIVE (spawnRunner() default) while pass1's TAP
 * had already been emitted via emitSync; if that rerun exited nonzero with ≤12 failed files,
 * the flake-retry red path re-emitted r.stdout — the SAME pass1 bytes — producing a double
 * plan in the gate's tap file. Fix: the rerun is spawned BUFFERED ({ live: false }) and no
 * early emitSync happens on the native-crash path, so the rerun becomes the single buffered
 * authoritative stream and the final exactly-once emission owns its bytes.
 * (run-all has no TAP fixtures in tests/unit/cli — source-contract pin per repo convention.)
 * Run: node --test tests/unit/cli/w11-runall-native-crash-buffered.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const runAllSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../run-all.mjs'), 'utf8')

test('run-all: native-crash rerun is spawned buffered and emits nothing early', () => {
  // locate the native-crash retry branch
  const branchIdx = runAllSrc.indexOf('onlyNativeCrash(String(r.stdout))')
  assert.ok(branchIdx > 0, 'native-crash branch must exist')
  const nextBranchIdx = runAllSrc.indexOf("r.status !== 0 && !r.error && r.stdout")
  const branch = runAllSrc.slice(branchIdx, nextBranchIdx)
  assert.ok(/spawnRunner\(null, \{ live: false \}\)/.test(branch),
    'native-crash rerun must be spawned buffered { live: false }')
  assert.ok(!/emitSync\(/.test(branch),
    'the native-crash branch must NOT emit pass1 (or anything) early — the final exactly-once emission owns the buffered rerun stream')
})

// W12 2026-10-26: pass1 streams live again (Fix 4); only the rebuilt/appended passes stay
// buffered — assertion updated to the new contract.
test('run-all: every REBUILT-capable pass is spawned buffered (native rerun + flake-retry pass; pass1 streams live per W12 Fix 4)', () => {
  const code = runAllSrc.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(/let r = await spawnRunner\(\)/.test(code),
    'pass1 must be spawned live (spawnRunner() with no { live } override) — 0-byte-TAP contract')
  const calls = (code.match(/await spawnRunner\(/g) || []).length
  const buffered = (code.match(/await spawnRunner\([\s\S]*?\{ live: false \}\)/g) || []).length
  assert.ok(calls >= 2, 'spawnRunner call sites must exist')
  assert.equal(buffered, calls - 1,
    'every spawnRunner call EXCEPT pass1 must pass { live: false } (rebuilt/appended streams stay buffered)')
})
