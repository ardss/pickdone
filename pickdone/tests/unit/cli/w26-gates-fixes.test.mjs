/**
 * W26 gate fixes (2026-11-01) — six gate/test-infrastructure repairs, anchored here:
 *   ① cssom-integrity countTopLevel escape branch was dead code ('\\\\' is the 2-char "\\"
 *     string at runtime, never equal to the 1-char css[i]) → \" / \' inside a CSS string closed
 *     the quote scan early and miscounted top-level rules. Fix: extracted to
 *     tests/lib/css-top-level-rules.mjs with the corrected '\\' literal; anchored below.
 *   ② check-hover-contrast main loop compared raw hc===bc (no var() normalization) while its
 *     negative self-test DID normalize — var(--brand) vs var(--brand, #0f9d8f) blue-on-blue
 *     dodged the gate and the selftest masked the gap. Fix: shared sameColorAfterVarNorm
 *     predicate + mixed-spelling selftest sample; anchored via HOVER_CONTRAST_SELFTEST run.
 *   ③ check-command-bus write-site scanner captured [A-Za-z]+ while check-ipc-op-coverage.cjs
 *     OP_ID is [A-Za-z_][A-Za-z0-9_]* — underscore/digit ops invisible to the single-door proof.
 *     Fix: OP_ID caliber unified + selftest anchor (asserted via --selftest exit 0).
 *   ④ run-interactions-gated appCwd used the percent-encoded URL pathname (spaces/non-ASCII repo
 *     paths → spawn ENOENT with no 'error' handler → 10min watchdog stall). Fix: fileURLToPath +
 *     error handlers; anchored by source assertions + a decoding sanity check.
 *   ⑤ check-cache-stamp fail-closed gitOk probe ran AFTER the first git calls (raw throw before
 *     the refuse-fake-green message). Fix: probe first, exit fail-closed; anchored by a run with
 *     a bogus GIT_DIR (must exit 1 with the 拒绝假绿 message, not crash raw).
 *   ⑥ check-file-size --update-baseline used a bare writeFileSync (tear → corrupt ratchet
 *     baseline JSON → gate reds forever). Fix: tmp+fsync+rename like check-coverage-ratchet;
 *     anchored by a fixture run asserting a clean JSON and zero leftover tmp files.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { countTopLevel } from '../../lib/css-top-level-rules.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const CLI = f => path.join(PICKDONE, 'cli', f)
const runGate = (file, args = [], env = {}) =>
  spawnSync(process.execPath, [CLI(file), ...args], { cwd: PICKDONE, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } })

test('① countTopLevel: escaped quotes inside strings no longer close the scan early', () => {
  // File-text shape: content:"say \"hi\"" — the escaped \" must NOT terminate the string scan.
  const dbl = '.a::after { content: "say \\"hi\\"" }\n.b { color: red }\n'
  assert.equal(countTopLevel(dbl), 2)
  // Single-quote variant: content:'it\'s'
  const sgl = ".a::before { content: 'it\\'s' }\n.b {}\n"
  assert.equal(countTopLevel(sgl), 2)
  // Regression guard: comment containing a quote must still be skipped entirely
  assert.equal(countTopLevel('/* "nope */ .c { color: red }\n'), 1)
  // Nested braces and unbalanced-at-EOF strings must not crash / miscount
  assert.equal(countTopLevel('@media x { .d { color: red } }\n'), 1)
  // Unterminated string swallows the rest of the file (no further top-level `{` after it)
  assert.equal(countTopLevel('.e { content: "unterminated'), 1)
})

test('② hover-contrast gate: main loop normalizes var(--brand) spellings (selftest green)', () => {
  const r = runGate('check-hover-contrast.cjs', [], { HOVER_CONTRAST_SELFTEST: '1' })
  assert.equal(r.status, 0, 'selftest run failed: ' + r.stderr)
  assert.match(r.stdout, /负向验证通过/)
  // The mixed-spelling sample (var(--brand) vs var(--brand, #0f9d8f)) rides the shared predicate
  assert.match(r.stdout, /坏规则被正确检出/)
})

test('③ command-bus gate selftest (incl. underscore/digit op caliber anchor) passes', () => {
  const r = runGate('check-command-bus.cjs', ['--selftest'])
  assert.equal(r.status, 0, 'selftest failed: ' + r.stderr)
  assert.match(r.stdout, /self-test passed/)
})

test('④ run-interactions-gated: appCwd via fileURLToPath (decoded) + spawn error handlers', () => {
  const src = fs.readFileSync(path.join(PICKDONE, 'tests', 'run-interactions-gated.mjs'), 'utf8')
  assert.match(src, /fileURLToPath\(import\.meta\.url\)/)
  assert.doesNotMatch(src, /\.pathname\.replace\(/) // the percent-encoded form must be gone
  assert.match(src, /child\.on\('error'[\s\S]{0,40}res\(1\)/) // run() spawn settles on error
  // Decoding sanity: a repo path with a space must round-trip through fileURLToPath
  const p = 'K:\\dir with space\\子目录\\tests'
  const url = 'file:///' + encodeURI(p.replace(/\\/g, '/'))
  assert.equal(fileURLToPath(url), p)
})

test('⑤ cache-stamp gate is fail-closed on broken git (probe now precedes all other git calls)', () => {
  const bogusGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-nogit-'))
  const r = runGate('check-cache-stamp.js', [], { GIT_DIR: bogusGitDir, GIT_WORK_TREE: bogusGitDir })
  fs.rmSync(bogusGitDir, { recursive: true, force: true })
  assert.equal(r.status, 1, 'gate must red, not fake-green: ' + r.stdout)
  assert.match(r.stderr, /拒绝假绿/)
  assert.doesNotMatch(r.stderr, /execFileSync|ENOENT|throw/i) // fail-closed message, not a raw crash
})

test('⑥ file-size --update-baseline persists atomically (clean JSON, zero tmp leftovers)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-fsize-'))
  const baseline = path.join(root, 'structure-baseline.json')
  fs.writeFileSync(path.join(root, 'tiny.js'), 'const a = 1\n')
  const r = spawnSync(process.execPath, [CLI('check-file-size.cjs'), '--update-baseline'], {
    cwd: PICKDONE, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GATE_ROOT: root, GATE_BASELINE: baseline }
  })
  assert.equal(r.status, 0, 'update-baseline failed: ' + r.stderr)
  const doc = JSON.parse(fs.readFileSync(baseline, 'utf8')) // must be a clean, parseable doc
  assert.ok('commitments' in doc)
  const leftovers = fs.readdirSync(root).filter(f => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'tmp write file must be renamed away, not left behind')
  fs.rmSync(root, { recursive: true, force: true })
})
