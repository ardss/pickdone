// Real tests of the CI/Release workflows — guard against drift of the LIVE workflows at the repo root.
// 2026-09-01 审计实锤：仓库曾同时存在两份 ci.yml（根目录现役 + pickdone/.github 死文件），
// 而本测试读的是死文件——矩阵/白名单断言全绿但现役工作流无人管（教科书级假绿）。
// 现指向仓库根 ../.github/workflows/（GitHub Actions 唯一读取位置）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT_WF = resolve('..', '.github', 'workflows')
const ci = () => readFileSync(resolve(ROOT_WF, 'ci.yml'), 'utf8')
const rel = () => readFileSync(resolve(ROOT_WF, 'release.yml'), 'utf8')

test('CI workflow: root .github/workflows/ci.yml exists (GitHub only reads the repo-root workflows)', () => {
  assert.ok(existsSync(resolve(ROOT_WF, 'ci.yml')), 'root ci.yml must exist; a workflow anywhere else is a dead file')
})

test('CI workflow: no dead workflow copies inside pickdone/.github (the fake-green incident)', () => {
  assert.ok(!existsSync('.github/workflows/ci.yml'), 'pickdone/.github/workflows/ci.yml must not exist (GitHub never reads it; guard tests reading it are fake-green)')
})

test('CI workflow: runs on windows and ubuntu (release artifact is win; ubuntu adds regression value; macos has no artifact)', () => {
  const src = ci()
  assert.ok(src.includes('windows-latest'), 'ci.yml must include windows-latest')
  assert.ok(src.includes('ubuntu-latest'), 'ci.yml must include ubuntu-latest')
})

test('CI workflow: must run npm run check:all (full gate coverage)', () => {
  assert.ok(ci().includes('npm run check:all'), 'ci.yml must run npm run check:all')
})

test('CI workflow: job-level timeout-minutes is set (default 360min burns the runner on a hang)', () => {
  assert.ok(/timeout-minutes:\s*\d+/.test(ci()), 'ci.yml must set timeout-minutes')
})

test('CI workflow: uploads failure logs (Electron spawn flakiness must be diagnosable)', () => {
  assert.ok(ci().includes('upload-artifact'), 'ci.yml must upload logs on failure')
})

test('CI workflow: working-directory is pickdone (package.json lives in a subdirectory)', () => {
  const matches = ci().match(/working-directory:\s*pickdone/g) || []
  assert.ok(matches.length >= 3, 'ci.yml must set working-directory: pickdone for install/test/gates (got ' + matches.length + ')')
})

test('CI workflow: runs build-whitelist.mjs to prevent packaging dead patterns', () => {
  assert.ok(ci().includes('build-whitelist.mjs'), 'ci.yml must run build-whitelist.mjs to prevent manual files drift')
})

test('Release workflow: gates must be >= CI (check:all, not the weaker check) — a tag must not bypass gates', () => {
  const src = rel()
  assert.ok(src.includes('npm run check:all'), 'release.yml must run check:all (weaker check let bad tags ship)')
  assert.ok(!/run:\s*npm run check\s*$/m.test(src), 'release.yml must not use the weak `npm run check`')
})

test('Release workflow: verifies the packaged artifact (verify-packaged) and sets timeout', () => {
  const src = rel()
  assert.ok(src.includes('verify-packaged'), 'release.yml must run verify:packaged on the built artifact')
  assert.ok(/timeout-minutes:\s*\d+/.test(src), 'release.yml must set timeout-minutes')
})
