/**
 * 回归：verify-packaged.cjs 的 linux 更新元数据对账必须实测 sha512/size（2026-09-24 泛化自
 * Windows latest.yml 对账）——latest-linux*.yml 引用的产物被替换或拷贝残缺时要在打包门禁被拦下，
 * 不能漏到用户端自动更新失败。断言的是用户可见行为：门禁脚本对好产物放行、对坏产物 FAIL 退出非 0。
 * 运行：node --test tests/verify-packaged-linux-sha.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, 'scripts', 'verify-packaged.cjs')

async function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-linux-sha-'))
  const unpacked = path.join(tmp, 'dist-fixture')
  const resCli = path.join(unpacked, 'resources', 'cli')
  fs.mkdirSync(resCli, { recursive: true })
  fs.writeFileSync(path.join(resCli, 'SKILL.md'), '# skill')
  fs.writeFileSync(path.join(resCli, 'pickdone.js'), '')
  fs.writeFileSync(path.join(resCli, 'lib.js'), '')
  // vendor 平台 prebuild（win32-x64，extraResources 全量副本检查）
  const prebuildDir = path.join(unpacked, 'resources', 'vendor', 'better-sqlite3-multiple-ciphers', 'prebuilds')
  fs.mkdirSync(prebuildDir, { recursive: true })
  // extraResources 是全平台副本(verify-packaged 按宿主 platformPrebuild 校验)——夹具必须
  // 写全平台,只写 win32 会在 linux CI 上误判缺驱动而 FAIL
  for (const pre of ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']) {
    fs.writeFileSync(path.join(prebuildDir, pre + '.node'), 'dummy')
  }
  // resources/package.json（版本对账基准）
  fs.writeFileSync(path.join(unpacked, 'resources', 'package.json'), JSON.stringify({ name: 'pickdone', version: '1.0.0' }))
  // 宿主 cwd 侧：package.json（无白名单包）+ renderer-dist/index.html
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', build: { files: [] } }))
  fs.mkdirSync(path.join(tmp, 'renderer-dist'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'renderer-dist', 'index.html'), '<html><body><script src="renderer-dist/x.js"></script></body></html>')
  // 真 asar：含根 package.json、renderer 入口与白名单资产
  const req = createRequire(SCRIPT)
  const asar = req('@electron/asar')
  const staging = path.join(tmp, 'staging')
  fs.mkdirSync(path.join(staging, 'renderer-dist'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'assets', 'vendor-lib'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'assets', 'fonts'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'assets', 'img'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'pickdone', main: 'index.js', version: '1.0.0' }))
  fs.writeFileSync(path.join(staging, 'renderer-dist', 'index.html'), '<html><body><script src="renderer-dist/x.js"></script></body></html>')
  fs.writeFileSync(path.join(staging, 'renderer-dist', 'x.js'), '')
  fs.writeFileSync(path.join(staging, 'assets', 'vendor-lib', 'x'), '')
  fs.writeFileSync(path.join(staging, 'assets', 'fonts', 'x'), '')
  fs.writeFileSync(path.join(staging, 'assets', 'img', 'x'), '')
  await asar.createPackage(staging, path.join(unpacked, 'resources', 'app.asar'))
  return { tmp, unpacked }
}

function writeYml(unpacked, artifactName, shaB64, size) {
  const yml = [
    'version: 1.0.0',
    'path: ' + artifactName,
    'files:',
    '  - url: ' + artifactName,
    '    sha512: ' + shaB64,
    '    size: ' + size,
    'releaseName: PickDone 1.0.0',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(unpacked, 'latest-linux.yml'), yml)
}

function run(fix) {
  return spawnSync(process.execPath, [SCRIPT, '--dir', fix.unpacked], { cwd: fix.tmp, encoding: 'utf8' })
}

test('linux 更新元数据：产物与 yml 的 sha512/size 一致 → 门禁放行并打印实测通过', async () => {
  const fix = await makeFixture()
  try {
    const artifact = Buffer.from('fake-appimage-bytes')
    fs.writeFileSync(path.join(fix.unpacked, 'PickDone-1.0.0.AppImage'), artifact)
    writeYml(fix.unpacked, 'PickDone-1.0.0.AppImage',
      crypto.createHash('sha512').update(artifact).digest('base64'), artifact.length)
    const r = run(fix)
    assert.equal(r.status, 0, 'stdout/stderr: ' + r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /latest-linux\.yml.*sha512\/size 实测通过/s)
  } finally { fs.rmSync(fix.tmp, { recursive: true, force: true }) }
})

test('linux 更新元数据：产物被替换（sha512/size 不符）→ 门禁 FAIL 非零退出', async () => {
  const fix = await makeFixture()
  try {
    const declared = Buffer.from('fake-appimage-bytes')
    writeYml(fix.unpacked, 'PickDone-1.0.0.AppImage',
      crypto.createHash('sha512').update(declared).digest('base64'), declared.length)
    // 同目录放的是被替换/残缺的产物
    fs.writeFileSync(path.join(fix.unpacked, 'PickDone-1.0.0.AppImage'), Buffer.from('tampered'))
    const r = run(fix)
    assert.notEqual(r.status, 0, 'stdout/stderr: ' + r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /latest-linux\.yml 与 PickDone-1\.0\.0\.AppImage 实测不符/)
  } finally { fs.rmSync(fix.tmp, { recursive: true, force: true }) }
})
