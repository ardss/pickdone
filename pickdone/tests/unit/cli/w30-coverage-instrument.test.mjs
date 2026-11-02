/**
 * W30 (2026-11-01) 覆盖率仪器统一 — 锚测试。
 * 背景:check-test-summary --with-coverage 原本裸传 --experimental-test-coverage,run-all 写出的
 * coverage-summary.json suite 标签是 'all'(全量池),而棘轮门禁只认 'unit' 为校准仪器——两台
 * 仪器各测各的,共享槽里永远不是校准口径。统一后 --with-coverage 必钉 --suite=unit:
 *   ① --with-coverage 单用 → suite=unit;
 *   ② --with-coverage + --core → 立即红退出(池为 unit∩core,标签 'unit+core' 会被
 *      summaryIsTierScoped 判共享槽污染;组合无合法口径);
 *   ③ --affected dirs 与 unit 池(tests/unit/** + 兄弟 test/)求交集,交集为空去掉 --dirs
 *      (降级全量 unit 口径),避免 run-all 空命中硬红。
 * 附带锚定:棘轮 --await-summary 死等上限已从 12min 降到 3min(上游 stage 已死时不再陪尸)。
 * Run: node --test tests/unit/cli/w30-coverage-instrument.test.mjs
 */
import { createRequire } from 'module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const { resolveCoverageScope, UNIT_POOL_DIRS } = require_('../../../cli/check-test-summary.cjs')
const { SUMMARY_WAIT_MS } = require_('../../../cli/check-coverage-ratchet.cjs')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('unit pool definition matches run-all suiteOf: tests/unit/** + sibling test/', () => {
  assert.deepEqual(UNIT_POOL_DIRS, ['tests/unit', 'test'])
})

test('--with-coverage alone pins --suite=unit (the ratchet calibration instrument)', () => {
  const r = resolveCoverageScope({ withCoverage: true, core: false, affectedDirs: null })
  assert.equal(r.suite, 'unit')
  assert.equal(r.fatal, undefined)
  assert.equal(r.degraded, false)
})

test('--with-coverage without the flag is a no-op passthrough (dirs untouched)', () => {
  const r = resolveCoverageScope({ withCoverage: false, core: true, affectedDirs: ['tests/unit/store'] })
  assert.equal(r.suite, null)
  assert.deepEqual(r.dirs, ['tests/unit/store'])
  assert.equal(r.fatal, undefined)
})

test('--with-coverage + --core is fatal (unit+core tag = ratchet slot pollution)', () => {
  const r = resolveCoverageScope({ withCoverage: true, core: true, affectedDirs: null })
  assert.ok(r.fatal, 'must carry a fatal reason')
  assert.equal(r.suite, null)
})

test('affected dirs intersect with the unit pool (non-unit prefixes dropped)', () => {
  const r = resolveCoverageScope({
    withCoverage: true, core: false,
    affectedDirs: ['tests/unit/store', 'tests/unit/main', 'tests/integration/electron', 'src/renderer']
  })
  assert.equal(r.suite, 'unit')
  assert.deepEqual(r.dirs, ['tests/unit/store', 'tests/unit/main']) // filtered in request order; sorting stays scopeFor's job
  assert.equal(r.degraded, false)
})

test('sibling test/ dir is part of the unit pool (sibling specs are unit-classified)', () => {
  const r = resolveCoverageScope({ withCoverage: true, core: false, affectedDirs: ['test', 'tests/unit/lib'] })
  assert.deepEqual(r.dirs, ['test', 'tests/unit/lib'])
})

test('empty intersection → dirs dropped entirely, degraded=true (full unit pool, no run-all hard red)', () => {
  const r = resolveCoverageScope({ withCoverage: true, core: false, affectedDirs: ['tests/integration'] })
  assert.equal(r.suite, 'unit')
  assert.equal(r.dirs, null)
  assert.equal(r.degraded, true)
})

test('exact pool-root entries survive the intersection (tests/unit itself, test itself)', () => {
  const r = resolveCoverageScope({ withCoverage: true, core: false, affectedDirs: ['tests/unit', 'tests/lib'] })
  assert.deepEqual(r.dirs, ['tests/unit'])
})

test('ratchet --await-summary dead-wait is capped at 3 minutes (was 12 — no more babysitting a dead stage)', () => {
  assert.ok(SUMMARY_WAIT_MS <= 3 * 60 * 1000, `SUMMARY_WAIT_MS=${SUMMARY_WAIT_MS} must be ≤ 3min`)
  assert.ok(SUMMARY_WAIT_MS > 0)
})

test('end-to-end: the gate binary reds immediately on --with-coverage --core (before any test spawn)', () => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['cli/check-test-summary.cjs', '--with-coverage', '--core'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000
  })
  assert.notEqual(r.status, 0, 'combo must be a red exit')
  assert.ok((r.stderr || '').includes('--with-coverage'), 'red message must name the forbidden combo')
  assert.ok(Date.now() - t0 < 20000, 'must fail fast BEFORE spawning the suite (no 4-minute unit run)')
})
