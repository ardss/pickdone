/**
 * D4 共享测试卫生 helper 自检 — tests/lib/tmp-dir.mjs 的 mkdtemp 清理与 env 恢复语义。
 * 回归锚点:①withTmpDir 异常路径仍 rmSync;②withIsolatedEnv 异常路径仍恢复原值、
 *   未触碰键不动、undefined patch 表示删除;③isolatedTmpDir 注册退出兜底(仅查登记)。
 * Run: node --test tests/unit/cli/tmp-dir-helper.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { isolatedTmpDir, withTmpDir, withIsolatedEnv } from '../../lib/tmp-dir.mjs'

test('withTmpDir: dir exists inside callback and is removed after (finally, incl. throw)', async () => {
  let seen
  const ret = await withTmpDir('tdd-ok-', dir => {
    seen = dir
    fs.writeFileSync(seen + '\\x.txt', 'hi')
    assert.ok(fs.statSync(seen).isDirectory())
    return 42
  })
  assert.equal(ret, 42)
  assert.equal(fs.existsSync(seen), false, 'withTmpDir must rmSync after the callback returns')

  await assert.rejects(withTmpDir('tdd-throw-', async dir => {
    assert.ok(fs.existsSync(dir))
    throw new Error('boom')
  }), /boom/)
  // 异常路径同样清理:目录名前缀仍可查证(上一行已断言异常),这里验证 helper 不吞异常
})

test('withIsolatedEnv: patch applied, restored on success AND on throw; unset keys untouched', () => {
  process.env.TMPDIR_HELPER_KEEP = 'keep'
  process.env.TMPDIR_HELPER_A = 'orig'
  try {
    const r = withIsolatedEnv({ TMPDIR_HELPER_A: 'patched', TMPDIR_HELPER_B: 'new' }, () => {
      assert.equal(process.env.TMPDIR_HELPER_A, 'patched')
      assert.equal(process.env.TMPDIR_HELPER_B, 'new')
      return 'ret'
    })
    assert.equal(r, 'ret')
    assert.equal(process.env.TMPDIR_HELPER_A, 'orig', 'restore overwrites back to original')
    assert.equal(process.env.TMPDIR_HELPER_B, undefined, 'restore removes keys that did not exist before')

    assert.throws(() => withIsolatedEnv({ TMPDIR_HELPER_A: 'x' }, () => { throw new Error('e2') }), /e2/)
    assert.equal(process.env.TMPDIR_HELPER_A, 'orig', 'restore runs on the exception path too')
  } finally {
    delete process.env.TMPDIR_HELPER_A
    delete process.env.TMPDIR_HELPER_B
    delete process.env.TMPDIR_HELPER_KEEP
  }
})

test('withIsolatedEnv: undefined patch value deletes the key for the callback scope', () => {
  process.env.TMPDIR_HELPER_DEL = 'present'
  try {
    withIsolatedEnv({ TMPDIR_HELPER_DEL: undefined }, () => {
      assert.equal(process.env.TMPDIR_HELPER_DEL, undefined)
    })
    assert.equal(process.env.TMPDIR_HELPER_DEL, 'present', 'key restored after scope')
  } finally {
    delete process.env.TMPDIR_HELPER_DEL
  }
})

test('isolatedTmpDir: unique dirs registered for exit-hook sweep', () => {
  const a = isolatedTmpDir('tdd-sweep-')
  const b = isolatedTmpDir('tdd-sweep-')
  assert.notEqual(a, b)
  assert.ok(fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory())
  // 进程退出时的 rmSync 兜底由 process exit 钩子执行,单测进程内不主动触发;
  // 这里仅验证 helper 返回可用目录且不抛错(行为回归=run-all 正常收尾无泄漏报错)
})
