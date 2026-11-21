/**
 * W27 gate fixes (2026-11-01) — six gate/test-infrastructure repairs, anchored here:
 *   ① check-file-size.cjs trackedSet() ran `git ls-files` WITHOUT -c core.quotePath=false —
 *     non-ASCII tracked paths came back as quoted octal escapes, tracked.has() missed them and
 *     the full-scan mode classified EXISTING tracked files as new (strict 600 tier) → false red
 *     on every CJK-named file. Fix: quotePath pin (same as the --staged calls / lint-staged.mjs).
 *     Anchored by a fixture git repo: a committed 620-line cli/中文*.js file (≤800 tier cap, >600
 *     strict cap) must pass; a genuinely-new 650-line file must still red (strict tier intact).
 *   ② lint-staged.mjs W25 staged-blob extraction flattened files to `i-<basename>` at the tmp
 *     root — .eslintrc.cjs directory-level overrides (tests/|cli/ node env) stopped matching
 *     (node files linted under the browser env) and --cache keys never repeated. Fix: mirror the
 *     original relative dirs under tmpDir. Anchored by source assertions + an eslint probe proving
 *     the mirrored path form hits the node-env override while the flat form does not.
 *   ③ journey-relay.cjs staged jrelay-env.cmd / jrelay-cli.cmd / jrelay-boot.ps1 at FIXED
 *     os.tmpdir() names — concurrent runs clobbered each other and crashes leaked the files.
 *     Fix: per-pid mkdtemp staging dirs; `jrelay-` joins the tests/lib/tmp-dir.mjs sweep family
 *     (cli/ is outside the extraction walk — same structural blind spot as todo-cov-).
 *   ④ check-media-lang.js markdown ref regex captured [^)\s]+ — references containing a space
 *     (or wrapped in <>) escaped BOTH the existence check and the EN-marker check (fail-open).
 *     Fix: capture [^)]+, trim, strip the <...> wrapper. Anchored by fixture runs.
 *   ⑤ check-fingerprint.js drive-letter rule only accepted backslash separators — `"K:/tmp/x"`
 *     and `'file:///K:/Users/...'` escaped. Fix: separator class [\\/]{1,2} + prefix class
 *     widened with `/` for the file-URL form. Anchored by fixture runs (w20 form).
 *   ⑥ check-i18n.js bracketDelta counted brackets inside string literals/comments — a `)` in a
 *     string truncated the block window early (CN continuation line missed) and a `(` in a
 *     string over-extended it (unrelated raw-CN line swallowed → false red). Fix: strip literals
 *     and comments before counting. Anchored by a two-sided fixture run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const CLI = f => path.join(PICKDONE, 'cli', f)

const linesFile = (dir, name, n) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), Array.from({ length: n }, (_, i) => `const a${i} = ${i}\n`).join(''))
}

// git env scrub — under the pre-commit hook GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE are injected
// into this process; the fixture repo's own git calls must NOT inherit them (same reason
// check-file-size's makeGit scrubs: they would redirect the fixture git ops at the real repo).
const fxEnv = () => {
  const e = { ...process.env }
  delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE
  return e
}
const fxGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: fxEnv() })

// —— ① check-file-size: trackedSet quotePath pin ——

test('① file-size: committed CJK-named file (620 lines > strict 600, ≤ tier 800) passes full scan', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-fs-fix-pid' + process.pid + '-'))
  try {
    fxGit(['init', '-q'], tmp)
    linesFile(tmp, 'cli/中文存量文件.js', 620) // tracked: ≤800 cli tier → green; strict-tier miss → red
    fxGit(['add', '.'], tmp)
    fxGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], tmp)
    const r = spawnSync(process.execPath, [CLI('check-file-size.cjs')], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, GATE_ROOT: tmp, GATE_BASELINE: path.join(tmp, 'baseline-absent.json') }
    })
    assert.equal(r.status, 0, `tracked CJK file must not eat the strict tier: exit=${r.status}\n${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /结构尺寸门禁通过/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('① file-size: a genuinely-new (untracked) 650-line file still reds on the strict tier', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-fs-new-pid' + process.pid + '-'))
  try {
    fxGit(['init', '-q'], tmp)
    linesFile(tmp, 'cli/brand-new.js', 650) // untracked → strict 600 → red
    const r = spawnSync(process.execPath, [CLI('check-file-size.cjs')], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, GATE_ROOT: tmp, GATE_BASELINE: path.join(tmp, 'baseline-absent.json') }
    })
    assert.equal(r.status, 1, 'strict tier must stay armed for truly-new files')
    assert.match(r.stderr, /新文件严档/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// —— ② lint-staged: mirrored extraction dirs ——

test('② lint-staged: staged-blob extraction mirrors the original relative directory', () => {
  const src = fs.readFileSync(CLI('lint-staged.mjs'), 'utf8')
  assert.match(src, /const dest = join\(tmpDir, \.\.\.name\.split\('\/'\)\)/)
  assert.match(src, /fs\.mkdirSync\(dirname\(dest\), \{ recursive: true \}\)/)
  assert.doesNotMatch(src, /join\(tmpDir, i \+ '-' \+ name\.split/) // flat form must be gone
  // Behavioral proof (config resolution): a node-env file at a MIRRORED temp path keeps the
  // tests/** node-env override (process/require defined), while the old FLAT temp-root path
  // falls back to the browser env and reds — exactly the false-red the fix removes.
  const tmpDir = path.join(PICKDONE, '.tmp-w27-lint-probe-' + process.pid)
  try {
    fs.mkdirSync(path.join(tmpDir, 'tests', 'unit', 'cli'), { recursive: true })
    const body = 'const x = process.argv\nconst y = require("node:fs")\nconsole.log(x, y)\n'
    fs.writeFileSync(path.join(tmpDir, 'tests', 'unit', 'cli', 'probe.mjs'), body)
    fs.writeFileSync(path.join(PICKDONE, 'probe-flat-w27.mjs'), body)
    const mirrored = spawnSync(process.execPath, [CLI('lint-staged.mjs').replace(/lint-staged\.mjs$/, '../node_modules/eslint/bin/eslint.js'), path.join(tmpDir, 'tests', 'unit', 'cli', 'probe.mjs'), '--quiet'], { cwd: PICKDONE, encoding: 'utf8' })
    assert.equal(mirrored.status, 0, 'mirrored path must hit the node-env override: ' + mirrored.stdout + mirrored.stderr)
    const flat = spawnSync(process.execPath, [path.join(PICKDONE, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'probe-flat-w27.mjs', '--quiet'], { cwd: PICKDONE, encoding: 'utf8' })
    assert.equal(flat.status, 1, 'flat path must demonstrate the old false-red (browser env, no process/require)')
    assert.match(flat.stdout, /'process' is not defined/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(path.join(PICKDONE, 'probe-flat-w27.mjs'), { force: true })
  }
})

// —— ③ journey-relay: pid-unique staging + tmp-dir sweep family ——

test('③ journey-relay: no fixed os.tmpdir() staging names; per-pid mkdtemp dirs; jrelay- joins sweep family', () => {
  const src = fs.readFileSync(CLI('journey-relay.cjs'), 'utf8')
  assert.doesNotMatch(src, /path\.join\(os\.tmpdir\(\),\s*'jrelay-(?:env\.cmd|cli\.cmd|boot\.ps1)'\)/)
  assert.match(src, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'jrelay-stage-pid' \+ process\.pid \+ '-'\)\)/)
  assert.match(src, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'jrelay-boot-pid' \+ process\.pid \+ '-'\)\)/)
  const tmpLib = fs.readFileSync(path.join(PICKDONE, 'tests', 'lib', 'tmp-dir.mjs'), 'utf8')
  assert.match(tmpLib, /FAMILY_FALLBACK = \/\^\(todo-\|todo-cov-\|jrelay-/) // fallback family widened
  assert.match(tmpLib, /new Set\(\['todo-', 'todo-cov-', 'jrelay-'/) // seeded: cli/ is outside the extraction walk
})

// —— ④ check-media-lang: space/angle-bracket refs reach both checks ——

const runMediaLang = (readmeEnBody, readmeZhBody, extraFiles = []) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-ml-pid' + process.pid + '-'))
  // the gate anchors ROOT at cli/ 上两级 — gate lives at proj/gate/cli so ROOT === proj
  const proj = path.join(tmp, 'outer', 'proj')
  fs.mkdirSync(path.join(proj, 'gate', 'cli'), { recursive: true })
  fs.copyFileSync(CLI('check-media-lang.js'), path.join(proj, 'gate', 'cli', 'check-media-lang.js'))
  fs.writeFileSync(path.join(proj, 'README.md'), readmeEnBody)
  fs.writeFileSync(path.join(proj, 'README.zh-CN.md'), readmeZhBody)
  for (const f of extraFiles) {
    fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true })
    fs.writeFileSync(path.join(proj, f), 'x')
  }
  const r = spawnSync(process.execPath, [path.join(proj, 'gate', 'cli', 'check-media-lang.js')], { encoding: 'utf8', timeout: 60000 })
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return r
}

test('④ media-lang: space-containing ref missing on disk is now a red (existence check reached)', () => {
  const r = runMediaLang(
    '![demo](docs/media/en/demo with space.png)\n',
    '![演示](docs/media/zh-演示.png)\n'
  )
  assert.equal(r.status, 1, 'old [^)\\s]+ regex never saw this ref — fail-open hole')
  assert.match(r.stderr, /missing file: docs\/media\/en\/demo with space\.png/)
})

test('④ media-lang: existing en-marked space/angle refs + plain zh refs stay green', () => {
  const r = runMediaLang(
    '![demo](docs/media/en/demo with space.png)\n![alt](<docs/media/en/angle b.png>)\n',
    '![演示](docs/媒体/zh 演示.png)\n',
    ['docs/media/en/demo with space.png', 'docs/media/en/angle b.png', 'docs/媒体/zh 演示.png']
  )
  assert.equal(r.status, 0, `all refs exist and are marked: ${r.stdout}${r.stderr}`)
})

// —— ⑤ check-fingerprint: forward-slash / file-URL drive-letter forms ——

const runFingerprint = (body) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-fp-pid' + process.pid + '-'))
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  for (const d of ['src', 'renderer', 'assets/css', 'browser-dev', 'shared']) fs.mkdirSync(path.join(tmp, d), { recursive: true })
  fs.copyFileSync(CLI('check-fingerprint.js'), path.join(tmp, 'cli', 'check-fingerprint.js'))
  // W33: the gate now delegates its walker to the shared lib-filescan.cjs — the fixture copy
  // needs the dependency alongside or the gate dies with MODULE_NOT_FOUND (w20 precedent)
  fs.copyFileSync(CLI('lib-filescan.cjs'), path.join(tmp, 'cli', 'lib-filescan.cjs'))
  if (body !== null) fs.writeFileSync(path.join(tmp, 'renderer', 'probe.js'), body + '\n')
  const r = spawnSync(process.execPath, [path.join(tmp, 'cli', 'check-fingerprint.js')], { encoding: 'utf8', timeout: 120000 })
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return r
}

test('⑤ fingerprint: `K:/tmp/x` (forward-slash) and `file:///K:/Users/...` (file URL) are red', () => {
  for (const probe of ['const p = "K:/tmp/x"', "const p = 'file:///K:/Users/me/notes'"]) {
    const r = runFingerprint(probe)
    assert.equal(r.status, 1, `must red on ${JSON.stringify(probe)}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /本机绝对路径/)
  }
})

test('⑤ fingerprint: escaped backslash form still red; plain relative /tmp stays green', () => {
  const red = runFingerprint('const p = "K:\\\\tmp\\\\y"')
  assert.equal(red.status, 1, 'backslash form must stay red: ' + red.stdout + red.stderr)
  const green = runFingerprint('const p = "/tmp/ok"\nconst q = process.env.TEMP')
  assert.equal(green.status, 0, `relative forms must stay green: ${green.stdout}${green.stderr}`)
})

// —— ⑥ check-i18n: bracket window ignores brackets in strings/comments ——

const runI18nAll = (files) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-i18n-pid' + process.pid + '-'))
  fs.mkdirSync(path.join(tmp, 'renderer', 'js'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true }) // --all walks shared/ unconditionally
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, 'renderer', 'js', name), body)
  const r = spawnSync(process.execPath, [CLI('check-i18n.js'), '--all'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GATE_ROOT: tmp }
  })
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return r
}

test('⑥ i18n: `)` inside a string no longer truncates the block window (miss → red); phantom `(` no longer over-extends (false red → green)', () => {
  const r = runI18nAll({
    // OLD bug: the ')' in line 2 counted -1 → window closed on line 2 → line 3's raw CN escaped
    // the scan entirely (miss → green). Fix: line 2 strips to no brackets → window grows to line 4.
    // (Line 2 carries NO CN so the reported first-hit line can only be line 3.)
    'truncation.js': "showError(\n  'plain x)',\n  '真实泄漏中文'\n)\n",
    // OLD bug: '(' inside the string counted +1 → window over-extended to swallow line 3 (false red).
    'overextend.js': "alert('normal text (')\n)\nconst unrelated = '硬编码中文'\n"
  })
  assert.equal(r.status, 1, 'the truncation miss must be red after the fix: ' + r.stdout + r.stderr)
  assert.match(r.stderr, /真实泄漏中文/) // miss-side: now caught
  // false-red-side: the unrelated overextend.js line stays out of the window
  // (match the probe text itself — the gate header contains the words 硬编码中文 too)
  assert.doesNotMatch(r.stderr, /unrelated = '硬编码中文/)
})
