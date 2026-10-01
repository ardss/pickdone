// dev-duo script dry-run unit: the launch plan must be correct without starting anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan } from '../../../scripts/dev-duo.mjs'

const testsDir = path.dirname(fileURLToPath(import.meta.url))

test('buildPlan: fresh temp dirs under .tmp-duo, per-instance env/args, B on sync port 58472', () => {
  const plan = buildPlan({ appRoot: 'K:/proj/pickdone', fresh: false })
  assert.equal(path.basename(plan.dirA), 'instance-a')
  assert.equal(path.basename(plan.dirB), 'instance-b')
  // The two instances get DIFFERENT userData dirs (that is what scopes the singleton lock)
  assert.notEqual(plan.instances[0].userDataDir, plan.instances[1].userDataDir)
  assert.ok(plan.instances[0].userDataDir.includes('.tmp-duo'))
  const [a, b] = plan.instances
  // CDP ports avoid 9333 (reserved for e2e) and each other
  assert.equal(a.cdpPort, 9433)
  assert.equal(b.cdpPort, 9434)
  assert.equal(a.cdpUrl, 'http://127.0.0.1:9433/json/version')
  assert.equal(b.cdpUrl, 'http://127.0.0.1:9434/json/version')
  // multi-instance opt-in + isolated data dir on BOTH; B carries the sync port override
  for (const inst of plan.instances) {
    assert.equal(inst.env.PICKDONE_MULTI, '1')
    assert.equal(inst.env.TODO_USER_DATA_DIR, inst.userDataDir)
    assert.ok(inst.args.some(arg => arg.startsWith('--remote-debugging-port=')))
  }
  assert.equal(a.env.TODO_SYNC_PORT, undefined)
  assert.equal(b.env.TODO_SYNC_PORT, '58472')
})

test('dry-run prints the plan and starts nothing (exit 0, no electron spawn)', () => {
  const res = spawnSync(process.execPath, [path.join(testsDir, '..', '..', '..', 'scripts', 'dev-duo.mjs'), '--dry-run'], {
    encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(res.status, 0)
  const out = res.stdout || ''
  assert.match(out, /\[dev-duo\] plan \(no launch\)/)
  assert.match(out, /PICKDONE_MULTI=1/)
  assert.match(out, /TODO_SYNC_PORT=58472/)
  assert.match(out, /9433/)
  assert.match(out, /9434/)
})
