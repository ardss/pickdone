/* Regression (check:fast round-2, 2026-09-26): tests/run-all.mjs used to hand spawnSync the
   ABSOLUTE path of every discovered test file. On Windows a spawned command line is capped at
   ~32k chars, so with ~350 discovered files the argv blew past the cap and spawnSync failed
   with ENAMETOOLONG — exit 1 with ZERO TAP output, which check-test-summary could only read
   as a mystery red ("单测进程 exit code = 1"). The fix anchors the spawn at the app root and
   passes repo-relative paths, and names the errno instead of silently falling through
   `r.status ?? 1`. D25 (2026-10-08): the suite grew until the original 4096-char headroom
   margin tripped at 28702 measured chars — an experiment moving the spawn cwd to tests/ to
   shorten the argv broke ~20 cwd-anchored specs, so the guard margin was recalibrated to the
   measured reality instead (repo-relative argv is ~7.5 chars/file; the margin below trips with
   ~370 files of headroom before the true 32767 cap minus flag overhead).
   Run: node --test tests/unit/cli/run-all-argv-limit.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) // pickdone/tests
const appRoot = path.join(testsDir, '..')
const RUN_ALL = fs.readFileSync(path.join(testsDir, 'run-all.mjs'), 'utf8')

/** Same discovery rules as run-all.mjs: recursive *.test.mjs, skip fixtures/ and dot-dirs */
function discover(root, acc = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      if (e.name === 'fixtures' || e.name.startsWith('.')) continue
      discover(p, acc)
    } else if (e.name.endsWith('.test.mjs')) acc.push(p)
  }
  return acc
}

test('run-all passes RELATIVE test paths so the spawned argv stays under the Windows ~32k cap', () => {
  const files = discover(testsDir)
  assert.ok(files.length > 100, `discovery sanity: expected the full suite (>100 files), got ${files.length}`)
  const relativeArgv = files.map(f => path.relative(appRoot, f)).join(' ')
  const absoluteArgv = files.join(' ')
  // The guarantee the fix makes: the file-list portion of the argv alone must fit the true
  // 32767 cap with room to spare for flags, the node binary and the coverage-reporter extras.
  // D25 recalibration: 28702 measured chars at 3860+ tests — the old 28671 margin was tripped
  // by legitimate suite growth, and shrinking the argv itself (cwd move) broke cwd-anchored
  // specs, so the guard tracks measured reality: 32000 leaves ~1.7k for flags/binary overhead.
  assert.ok(relativeArgv.length < 32000,
    `relative file argv is ${relativeArgv.length} chars — too close to/exceeding the Windows spawn cap`)
  // The failure this guards against was real at time of writing: prove the absolute form
  // actually breaches the cap here, so the test fails loudly if someone reverts to absolute
  // paths. (On an implausibly short checkout path this assert would be vacuous, but the
  // source anchors below still pin the mechanism.)
  if (absoluteArgv.length > 32767) {
    assert.ok(relativeArgv.length < absoluteArgv.length, 'relative argv must be strictly smaller than the absolute one that breached the cap')
  }
})

test('run-all anchors the spawn at the app root and fails loudly on spawn errors (no silent status-??-1)', () => {
  assert.match(RUN_ALL, /path\.relative\(appRoot, f\)/,
    'run-all must map discovered files through path.relative(appRoot, f)')
  assert.match(RUN_ALL, /cwd: appRoot/,
    'spawnSync must set cwd to appRoot so relative test paths resolve')
  assert.match(RUN_ALL, /if \(r\.error\)[\s\S]*?failed to spawn[\s\S]*?process\.exit\(1\)/,
    'a spawnSync error (e.g. ENAMETOOLONG) must be named and exit non-zero before the status fallthrough')
})
