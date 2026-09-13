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

/* 2026-09-13 改造:原断言是对整个 YAML 文本做 includes —— 任何位置出现子串即绿(如注释里提到也算),
 * 且 `matches.length >= 3` 这类下限断言近乎恒真。改为最小行级结构校验:按 `- ` 切出 step 块,
 * 断言关键 job/step 真实存在、且每个跑 npm 的 step 都被 working-directory: pickdone 限定。 */
const ciLines = () => ci().split(/\r?\n/)

// Split the check job's steps into blocks: a block starts at a `- ` list item and owns the lines until the next one
function stepBlocks (lines) {
  const blocks = []
  let cur = null
  for (const line of lines) {
    if (/^\s{6,}- /.test(line)) { cur = [line]; blocks.push(cur) } else if (cur) cur.push(line)
  }
  return blocks
}
const blockText = b => b.join('\n')

test('CI workflow: runs on windows and ubuntu via the build matrix (release artifact is win; ubuntu adds regression value; macos has no artifact)', () => {
  // 锚定真实的 matrix 行而非全文子串:os 数组必须精确声明这两个 runner,runs-on 必须消费 matrix
  assert.ok(ciLines().some(l => /^\s*os: \[windows-latest, ubuntu-latest\]\s*$/.test(l)),
    'matrix must declare exactly os: [windows-latest, ubuntu-latest]')
  assert.ok(ciLines().some(l => l.includes('runs-on: ${{ matrix.os }}')), 'job must run on the matrix os')
  assert.ok(!ciLines().some(l => l.includes('macos-latest')), 'macos has no artifact and must stay out of the matrix')
})

test('CI workflow: a step runs npm run check:all (full gate coverage, optionally under xvfb on linux)', () => {
  const hit = stepBlocks(ciLines()).some(b => /run:/.test(blockText(b)) && /(^|\s|-a )npm run check:all/m.test(blockText(b)))
  assert.ok(hit, 'ci.yml must have a step whose run executes npm run check:all (xvfb-run -a prefix allowed)')
})

test('CI workflow: job-level timeout-minutes is set (default 360min burns the runner on a hang)', () => {
  // job 级(4 空格缩进,与 step 属性同级):step 级 timeout 不能替代 job 级兜底
  assert.ok(ciLines().some(l => /^ {4}timeout-minutes:\s*\d+\s*$/.test(l)), 'ci.yml must set a job-level timeout-minutes')
})

test('CI workflow: uploads failure logs (Electron spawn flakiness must be diagnosable)', () => {
  // upload-artifact 必须是失败时才上传的日志 step,而不是无条件 artifact
  const logStep = stepBlocks(ciLines()).find(b => blockText(b).includes('actions/upload-artifact'))
  assert.ok(logStep, 'ci.yml must have an upload-artifact step')
  assert.ok(/if:\s*failure\(\)/.test(blockText(logStep)), 'failure logs must be gated on if: failure()')
})

test('CI workflow: every npm step is scoped to working-directory pickdone (package.json lives in a subdirectory)', () => {
  // 收紧原 `matches.length >= 3` 恒真下限:逐 step 校验 —— 凡 run 里出现 npm 命令的 step,
  // 必须显式带 working-directory: pickdone(apt/sudo、纯 node 脚本无 npm 的 step 豁免)
  const npmBlocks = stepBlocks(ciLines()).filter(b => /run:/.test(blockText(b)) && /(^|\s)(npm|xvfb-run)\s/.test(blockText(b)))
  assert.ok(npmBlocks.length >= 3, 'expected several npm steps in ci.yml, found ' + npmBlocks.length + ' (parser drift?)')
  const unscoped = npmBlocks.filter(b => !blockText(b).includes('working-directory: pickdone'))
  assert.deepEqual(unscoped.map(blockText), [], 'every npm step must set working-directory: pickdone')
})

test('CI workflow: runs build-whitelist.mjs to prevent packaging dead patterns', () => {
  // 必须出现在某个 step 的 run 块里(执行),而不是注释/文件名碰巧包含
  const hit = stepBlocks(ciLines()).some(b => /run:/.test(blockText(b)) && blockText(b).includes('node scripts/build-whitelist.mjs'))
  assert.ok(hit, 'ci.yml must execute node scripts/build-whitelist.mjs to prevent manual files drift')
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
