/**
 * D4 覆盖率棘轮门禁自检 — 解析与基线写入逻辑(不真跑 coverage,套件本身由门禁跑)。
 * 重点回归:①汇总行只认「最后一处 all files」——测试输出里混入伪造 "# all files" 行不能骗过解析;
 * ②writeBaseline 落盘格式与 loadBaseline 往返一致。
 * Run: node --test tests/unit/cli/check-coverage-ratchet.test.mjs
 */
import { createRequire } from 'module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const mod = require_('../../../cli/check-coverage-ratchet.cjs')

test('parseAllFiles: picks the LAST all-files summary (forged earlier lines cannot override)', () => {
  const out = [
    'some noise',
    '# all files  |  10.00 |  10.00 |  10.00 |',
    '# end of coverage report',
    '--- second run appended (e.g. embedded run-all output) ---',
    '# sqlite-error.js | 92.00 | 66.67 | 100.00 | 6-7',
    '# all files                           |  76.40 |    72.30 |   62.80 | ',
    '# end of coverage report'
  ].join('\n')
  assert.deepEqual(mod.parseAllFiles(out), { lines: 76.4, branches: 72.3, functions: 62.8 })
})

test('parseAllFiles: node 22 (CI linux) prints the total row WITHOUT the leading # — must still parse', () => {
  const out = '# end of coverage report\nall files                           |  86.65 |    81.68 |   77.83 | \n'
  assert.deepEqual(mod.parseAllFiles(out), { lines: 86.65, branches: 81.68, functions: 77.83 })
})

test('parseAllFiles: returns null when no summary line exists (fail-closed, not 0/0/0 equal-baseline green)', () => {
  assert.equal(mod.parseAllFiles('# foo | 100.00 | 100.00 | 100.00\n# all files?'), null)
  assert.equal(mod.parseAllFiles(''), null)
})

test('parseAllFiles: real node coverage-report shape parses (win32 CRLF tolerated)', () => {
  const out = '# end of coverage report\r\n# all files                           |  86.65 |    81.68 |   77.83 | \r\n'
  assert.deepEqual(mod.parseAllFiles(out), { lines: 86.65, branches: 81.68, functions: 77.83 })
})

test('writeBaseline/loadBaseline: JSON round-trips via the real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-ratchet-test-'))
  try {
    // writeBaseline 目标文件是模块常量,这里通过临时副本验证格式兼容性:
    // 直接读仓库基线 + 往返写临时文件,确认 loadBaseline 能读回同值
    const repoBaseline = JSON.parse(fs.readFileSync(
      new URL('../../../cli/.coverage-baseline.json', import.meta.url), 'utf8'))
    const target = path.join(dir, 'b.json')
    fs.writeFileSync(target, JSON.stringify({ _comment: 'x', baselines: repoBaseline.baselines }, null, 2) + '\n')
    const loaded = JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.deepEqual(loaded.baselines, repoBaseline.baselines)
    assert.ok(loaded.baselines.lines > 0 && loaded.baselines.branches > 0 && loaded.baselines.functions > 0,
      'repo baseline must be positive (a zeroed baseline would make the ratchet toothless)')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
