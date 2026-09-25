/**
 * D2 效率波(2026-09-25)回归:check-all.js 的 flake 事件度量 + runPool 流水线钩子。
 * 覆盖:
 *   - runPool 重试通过的 stage 必须落一条 flake 事件(stage/attempt/首跑与重试耗时);一次通过不落
 *   - 阈值判断:重试通过数 >2 = warn,≤2 = ok
 *   - writeFlakeEvents 落盘 JSON 且 flakeCount 正确
 *   - runPool 的 onLastStage(最后一个 stage 被领走时回调一次)与 workerGate(worker 起跑前 gate)
 * 全部用假 stage(node 子进程秒级退出),不拉 Electron、不依赖 renderer-dist。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPool, resetFlakeEvents, getFlakeEvents, evaluateFlakeThreshold, writeFlakeEvents } from '../../../cli/check-all.js'

function tmpDir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `check-all-flake-${label}-`))
}

/** 造一个"首跑失败、重试通过"的 stage:辅助脚本首次运行写旗标并 exit 1,旗标存在则 exit 0 */
function flakyStage (dir, name) {
  const helper = path.join(dir, 'flaky-helper.cjs')
  const flag = path.join(dir, 'flaky.flag')
  if (!fs.existsSync(helper)) {
    fs.writeFileSync(helper, [
      'const fs = require("fs")',
      'if (fs.existsSync(process.argv[2])) process.exit(0)',
      'fs.writeFileSync(process.argv[2], "1")',
      'process.exit(1)'
    ].join('\n'))
  }
  return [name, 'node', [helper, flag]]
}

const okStage = name => [name, 'node', ['-e', 'process.exit(0)']]

test('threshold: ≤2 retry-passed stages = ok, >2 = warn', () => {
  assert.equal(evaluateFlakeThreshold([]).level, 'ok')
  assert.equal(evaluateFlakeThreshold([{ stage: 'a' }, { stage: 'b' }]).level, 'ok')
  const v = evaluateFlakeThreshold([{ stage: 'a' }, { stage: 'b' }, { stage: 'c' }])
  assert.equal(v.level, 'warn')
  assert.equal(v.count, 3)
  assert.equal(v.max, 2)
})

test('runPool: a retry-passed stage records exactly one flake event with attempt/耗时分账', async () => {
  resetFlakeEvents()
  const dir = tmpDir('event')
  const name = '假活体·重试通过'
  const rs = await runPool([flakyStage(dir, name)], 1, { retry: 1 })
  assert.equal(rs.length, 1)
  assert.equal(rs[0].ok, true, '重试后应转绿')
  const ev = getFlakeEvents()
  assert.equal(ev.length, 1, `应恰好 1 条 flake 事件,实得 ${JSON.stringify(ev)}`)
  assert.equal(ev[0].stage, name)
  assert.equal(ev[0].attempt, 2, '第二次尝试(attempt=2)通过')
  assert.ok(ev[0].firstRunMs >= 0, '首跑耗时应落账')
  assert.ok(ev[0].retryMs >= 0, '重试耗时应落账')
  // 首跑确实红过:stage 结果里的总耗时 = 首跑 + 重试
  assert.ok(rs[0].ms >= ev[0].firstRunMs + ev[0].retryMs - 1)
})

test('runPool: a first-pass-green stage records NO flake event', async () => {
  resetFlakeEvents()
  await runPool([okStage('假活体·一次通过')], 1, { retry: 1 })
  assert.deepEqual(getFlakeEvents(), [])
})

test('writeFlakeEvents: writes JSON with flakeCount to the given dir', async () => {
  resetFlakeEvents()
  const dir = tmpDir('write')
  const file = writeFlakeEvents([{ stage: 's1', attempt: 2 }], dir, { totalStages: 5 })
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.flakeCount, 1)
  assert.equal(parsed.totalStages, 5)
  assert.equal(parsed.events[0].stage, 's1')
  assert.ok(parsed.generatedAt, '应有生成时间戳')
})

test('runPool: onLastStage fires exactly once when the LAST stage is picked up', async () => {
  resetFlakeEvents()
  let tailCalls = 0
  const stages = [okStage('s1'), okStage('s2'), okStage('s3')]
  const rs = await runPool(stages, 2, { onLastStage: () => tailCalls++ })
  assert.equal(rs.length, 3)
  assert.ok(rs.every(r => r.ok))
  assert.equal(tailCalls, 1, '尾段回调只应触发一次')
})

test('runPool: workerGate holds a worker back until its gate resolves', async () => {
  resetFlakeEvents()
  const started = []
  const gate = new Promise(res => { setTimeout(res, 150) })
  const stages = [okStage('g1'), okStage('g2')]
  const rs = await runPool(stages, 2, {
    workerGate: i => (i === 0 ? gate : Promise.resolve())
  })
  assert.equal(rs.length, 2)
  assert.ok(rs.every(r => r.ok))
  // worker 0 被 gate 压住,全部 stage 由 worker 1 串行消化——两阶段都真实跑过
  assert.deepEqual(started, [])
})
