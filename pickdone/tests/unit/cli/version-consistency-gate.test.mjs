/**
 * 版本一致性门禁（2026-11-21，beta.41 漂移的回归）
 *
 * 背景：beta.41 手工改 pickdone/package.json 到 beta.41，lockfile 忘跟停在 beta.40。
 * cli/check-test-scope.cjs 把两个清单都判成"版本中性"（pkg 只差 version；lock 完全没动），
 * 于是提交门禁把单测阶段整体跳过，漂移只被 P1-4h 单测发现——而那条单测正好被同一个门禁
 * DEFERRED 掉了。绿灯 + 漂移 + 无人知晓。
 *
 * 这里钉死新门禁的四条分支：一致放行、根字段漂移、packages[""] 漂移、无 lockfile 跳过，
 * 外加"真实仓库必须一致"（防止漂移再次落库）。
 *
 * Run: node --test tests/unit/cli/version-consistency-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = path.join(APP_ROOT, 'cli', 'check-version-consistency.cjs')

/** 跑门禁脚本，返回 { code, stdout, stderr } */
function runGate (dir) {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, `--dir=${dir}`], { encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    })
  })
}

function fixture ({ pkgVersion, lockVersion, lockPkgVersion, noLock = false, badJson = false }) {
  const dir = isolatedTmpDir('vc-gate-')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    badJson ? '{ not json' : JSON.stringify({ name: 'fixture', version: pkgVersion }, null, 2)
  )
  if (!noLock) {
    const lock = { name: 'fixture', version: lockVersion, lockfileVersion: 3, packages: { '': { name: 'fixture' } } }
    if (lockPkgVersion !== undefined) lock.packages[''].version = lockPkgVersion
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2))
  }
  return dir
}

test('一致时放行并回显版本', async () => {
  const dir = fixture({ pkgVersion: '1.2.3', lockVersion: '1.2.3', lockPkgVersion: '1.2.3' })
  const r = await runGate(dir)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /1\.2\.3/)
  assert.match(r.stdout, /版本一致性/)
})

test('根 version 漂移 → 拒绝，并同时点名两侧版本', async () => {
  const dir = fixture({ pkgVersion: '1.2.3', lockVersion: '1.2.2', lockPkgVersion: '1.2.3' })
  const r = await runGate(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /1\.2\.2.*≠.*1\.2\.3|1\.2\.3/)
  assert.match(r.stderr, /package-lock\.json version=1\.2\.2/)
  assert.match(r.stderr, /修复/)
})

test('只有 packages[""] 漂移 → 同样拒绝（lock 有两个版本字段）', async () => {
  const dir = fixture({ pkgVersion: '1.2.3', lockVersion: '1.2.3', lockPkgVersion: '1.2.2' })
  const r = await runGate(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /packages\[""\]\.version=1\.2\.2/)
})

test('没有 lockfile → 跳过而不是误红', async () => {
  const dir = fixture({ pkgVersion: '1.2.3', noLock: true })
  const r = await runGate(dir)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /无 package-lock\.json/)
})

test('package.json 不是合法 JSON → 拒绝（不当成"无问题"）', async () => {
  const dir = fixture({ pkgVersion: '1.2.3', lockVersion: '1.2.3', badJson: true })
  const r = await runGate(dir)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /不是合法 JSON/)
})

test('真实仓库的 package.json 与 lockfile 必须一致（漂移不得再次落库）', async () => {
  const r = await runGate(APP_ROOT)
  assert.equal(r.code, 0, `工作区清单已漂移：\n${r.stderr}`)
})
