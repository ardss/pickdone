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

test('run-all: every composing-capable pass is spawned buffered (flake-retry pass stays buffered too)', () => {
  const code = runAllSrc.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
  const calls = (code.match(/await spawnRunner\(/g) || []).length
  const buffered = (code.match(/await spawnRunner\([\s\S]*?\{ live: false \}\)/g) || []).length
  assert.ok(calls > 0, 'spawnRunner call sites must exist')
  assert.equal(buffered, calls,
    'every spawnRunner call must pass { live: false } — no live-streamed spawn may remain (double-emission contract)')
})
