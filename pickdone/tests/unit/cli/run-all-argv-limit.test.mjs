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

test('run-all compacts exact relative test paths below the Windows argv cap', () => {
  const files = discover(testsDir)
  assert.ok(files.length > 100, 'discovery must cover the full suite')
  const source = RUN_ALL.match(/function runnerFileArgs \(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(source, 'runnerFileArgs must exist in the real runner')
  const build = new Function('files', 'TEST_EXTS', 'readdirSync', 'path', 'appRoot',
    source + '; return runnerFileArgs()')
  const args = build(files, ['.test.mjs', '.test.js'], fs.readdirSync, path, appRoot)
  assert.ok(args.every(x => !path.isAbsolute(x)), 'every argument is app-root-relative')
  const expanded = args.flatMap(arg => {
    const norm = arg.replace(/\\/g, '/')
    const wildcard = /^(.*)\/\*(\.test\.(?:mjs|js))$/.exec(norm)
    if (!wildcard) return [path.resolve(appRoot, arg)]
    const dir = path.resolve(appRoot, wildcard[1])
    return fs.readdirSync(dir).filter(n => n.endsWith(wildcard[2])).map(n => path.join(dir, n))
  })
  assert.deepEqual(expanded.map(f => path.normalize(f)).sort(), files.map(f => path.normalize(f)).sort(),
    'safe globs must resolve to EXACTLY the discovered test files, with none omitted or added')
  assert.ok(args.join(' ').length < 32000,
    'compacted runner argv must leave space under the Windows 32k command-line ceiling')
})

test('run-all anchors the spawn at the app root and fails loudly on spawn errors (no silent status-??-1)', () => {
  assert.match(RUN_ALL, /path\.relative\(appRoot, f\)/,
    'run-all must map discovered files through path.relative(appRoot, f)')
  assert.match(RUN_ALL, /cwd: appRoot/,
    'spawnSync must set cwd to appRoot so relative test paths resolve')
  assert.match(RUN_ALL, /if \(r\.error\)[\s\S]*?failed to spawn[\s\S]*?process\.exit\(1\)/,
    'a spawnSync error (e.g. ENAMETOOLONG) must be named and exit non-zero before the status fallthrough')
})
