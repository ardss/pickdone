#!/usr/bin/env node
/**
 * 一键发版(SOP-06 的可执行形态——流程长进工具里,不依赖任何人记得文档):
 *   npm run release 0.3.0
 * 步骤(任一步失败即中止,不会推任何东西):
 *   1. 校验版本号格式 X.Y.Z;工作区干净
 *   2. CHANGELOG [Unreleased] 段非空 → 自动改名 [X.Y.Z] - 今天(空段=红:没东西可发就别发)
 *      若目标版本段落已存在=红(防重复发版);package.json version 自动写入 X.Y.Z
 *   3. npm run bump(缓存戳)
 *   4. npm run check:all 本机全绿(29 项,含本机视觉第④组——CI 跑不了的那道护航就在这一步)
 *   5. commit "chore(release): vX.Y.Z" → push main → tag vX.Y.Z → push tag
 *   6. 提示:盯 Actions;成功后跑 `npm run release:finalize X.Y.Z` 填正文+核产物
 * 配套: scripts/release-finalize.mjs(构建成功后的人工三查也代码化)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sh = (cmd, opts = {}) => execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const die = msg => { console.error('✗ release: ' + msg); process.exit(1) }
const say = msg => console.log('• ' + msg)
// Windows 上 npm 只有 npm.cmd(Node ≥18.20 禁止无 shell 生成 .cmd,直接 spawnSync 必 ENOENT/EINVAL)——借 cmd.exe 转发
const npm = (args, opts = {}) => process.platform === 'win32'
  ? sh(['cmd', '/d', '/s', '/c', 'npm ' + args.join(' ')], opts)
  : sh(['npm', ...args], opts)

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version || '')) die('用法: npm run release X.Y.Z')
const TAG = 'v' + version

// 1. 工作区干净
if (sh(['git', 'status', '--porcelain'])) die('工作区有未提交变更——先提交或清理')
say('工作区干净')

// 2. CHANGELOG:Unreleased 非空、目标段落不存在
const clPath = path.join(ROOT, '..', 'CHANGELOG.md')
let cl = fs.readFileSync(clPath, 'utf8')
const unreleased = cl.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/)
if (!unreleased) die('CHANGELOG 缺 [Unreleased] 段')
if (!unreleased[1].trim()) die('[Unreleased] 是空的——没东西可发就别发版')
if (cl.includes(`## [${version}]`)) die(`CHANGELOG 已存在 [${version}] 段——重复发版?`)
say('[Unreleased] 非空,待归版')

// 3. version 写入 + 段落改名(幂等保护:同笔内完成)
{
  const pPkg = path.join(ROOT, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pPkg, 'utf8'))
  if (pkg.version !== version) {
    if (sh(['git', 'tag', '--list', TAG])) die(`tag ${TAG} 已存在(本地/远端)——换版本号或先删 tag`)
    pkg.version = version
    fs.writeFileSync(pPkg, JSON.stringify(pkg, null, 2) + '\n')
    say(`package.json version -> ${version}`)
  }
  const today = sh(['node', '-p', 'new Date().toISOString().slice(0,10)'])
  cl = cl.replace('## [Unreleased]', `## [${version}] - ${today}`)
  fs.writeFileSync(clPath, cl, 'utf8')
  say(`CHANGELOG [Unreleased] -> [${version}] - ${today}`)
}

// 4. 缓存戳 + 全量门禁(视觉第④组只在本机跑,CI 跑不了——这就是为什么 tag 前必须本机过)
say('npm run bump …')
npm(['run', 'bump'], { stdio: 'inherit' })
say('npm run check:all(29 项,约 4-8 分钟;中止=Ctrl+C)…')
try {
  npm(['run', 'check:all'], { stdio: 'inherit' })
} catch {
  die('check:all 未全绿——修完再跑 npm run release(不会推任何东西)')
}

// 5. 提交 → push main → tag → push tag
sh(['git', 'add', '-A'])
try {
  sh(['git', 'commit', '-m', `chore(release): ${TAG}`])
} catch { /* 无变更可提交也允许(stamps 可能已同笔) */ }
say('commit chore(release) 完成')
sh(['git', 'push', 'origin', 'main'])
say('main 已推送')
sh(['git', 'tag', TAG])
sh(['git', 'push', 'origin', TAG])
say(`${TAG} 已推送,Release 工作流已触发`)

// 6. 收尾指引
console.log(`
✓ 发版准备完成。接下来:
  1. 盯 Actions 的 Release 工作流(约 10 分钟;CI 自动跳过视觉第④组)
  2. 构建成功后执行: npm run release:finalize ${version}
     (自动: 从 CHANGELOG 提正文填入 draft + 核四产物 + 查空正文/重名/缺件)
  3. GitHub Releases 页面人工过目 → 点 Publish
`)
