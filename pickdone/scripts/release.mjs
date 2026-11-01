#!/usr/bin/env node
/**
 * 一键发版(SOP-06 的可执行形态——流程长进工具里,不依赖任何人记得文档):
 *   npm run release 0.3.0
 * 步骤(任一步失败即中止,不会推任何东西):
 *   1. 校验版本号格式 X.Y.Z[-prerelease];工作区干净
 *   2. CHANGELOG [Unreleased] 段非空 → 自动改名 [X.Y.Z] - 今天(空段=红:没东西可发就别发)
 *      若目标版本段落已存在=红(防重复发版);package.json version 自动写入 X.Y.Z
 *   3. npm run bump(缓存戳)
 *   4. npm run check:all 本机全绿(数量随池内条目演进,以脚本输出汇总为准;含本机视觉第④组——CI 跑不了的那道护航就在这一步)
 *   5. create release/vX.Y.Z branch → commit → push branch → create PR (NO direct main push/tag)
 *   6. after reviewed PR merges into main: npm run release:tag X.Y.Z → Draft workflow; then finalize
 * 配套: scripts/release-finalize.mjs(构建成功后的人工三查也代码化)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { isReleaseVersion } from './release-version.mjs'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// stdio:'inherit' 时 execFileSync 返回 null(无捕获输出)——不能一律 .trim()
const sh = (cmd, opts = {}) => {
  const out = execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  return typeof out === 'string' ? out.trim() : ''
}
const die = msg => { console.error('✗ release: ' + msg); process.exit(1) }
const say = msg => console.log('• ' + msg)
// Windows 上 npm 只有 npm.cmd(Node ≥18.20 禁止无 shell 生成 .cmd,直接 spawnSync 必 ENOENT/EINVAL)——借 cmd.exe 转发
const npm = (args, opts = {}) => process.platform === 'win32'
  ? sh(['cmd', '/d', '/s', '/c', 'npm ' + args.join(' ')], opts)
  : sh(['npm', ...args], opts)

const version = process.argv[2]
// P1-1 (R5): prerelease versions accepted (e.g. 0.4.0-beta.15) — shared validator, unit-covered.
if (!isReleaseVersion(version)) die('用法: npm run release X.Y.Z[-prerelease]')
const TAG = 'v' + version

const RELEASE_BRANCH = 'release/' + TAG
const currentBranch = sh(['git', 'branch', '--show-current'])
if (currentBranch !== 'main' && currentBranch !== RELEASE_BRANCH) {
  die('发版准备只能从 main 或对应 release/vX.Y.Z 分支运行；当前分支 ' + currentBranch)
}


// 1. 工作区干净
if (sh(['git', 'status', '--porcelain'])) die('工作区有未提交变更——先提交或清理')
say('工作区干净')
if (currentBranch === 'main') {
  // Fail before writing changelogs if the release is not based on the reviewed main.
  const localHead = sh(['git', 'rev-parse', 'HEAD'])
  const remoteHead = sh(['git', 'rev-parse', 'origin/main'])
  if (localHead !== remoteHead) die('main 与 origin/main 不一致；先同步远端并重试')
  sh(['git', 'switch', '-c', RELEASE_BRANCH])
  say('已创建发布准备分支 ' + RELEASE_BRANCH)
}


// 2. CHANGELOG:Unreleased 非空、目标段落不存在
const clPath = path.join(ROOT, '..', 'CHANGELOG.md')
// 工作区可能是 CRLF(autocrlf=true 检出会 smudge)——归一后匹配,写回统一 LF,否则正则永不命中
let cl = fs.readFileSync(clPath, 'utf8').replace(/\r\n/g, '\n')
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
  // lock 版本同步(P1-4h tag-match 门比对 package.json 与 package-lock.json 两处——只写 pkg 会让
  // 发版自身的 check:all 红在自己脚下:2026-10-29 beta.21 三连红实锤,旧账「bump skipped lockfile」)
  const pLock = path.join(ROOT, 'package-lock.json')
  const lockRaw = fs.readFileSync(pLock, 'utf8')
  const lock = JSON.parse(lockRaw)
  if (lock.version !== version || (lock.packages && lock.packages[''] && lock.packages[''].version !== version)) {
    lock.version = version
    if (lock.packages && lock.packages['']) lock.packages[''].version = version
    fs.writeFileSync(pLock, JSON.stringify(lock, null, 2) + '\n')
    say(`package-lock.json version -> ${version}`)
  }
  const today = sh(['node', '-p', 'new Date().toISOString().slice(0,10)'])
  const promote = (text) => {
    // Rename [Unreleased] -> [X.Y.Z] and re-seed an empty [Unreleased] above it (keep-a-changelog
    // convention): without the seed the next release dies on "缺 [Unreleased] 段" or, worse, new
    // entries get appended directly under the released version header (0.3.1 实锤:发完即无段).
    return text.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${today}`)
  }
  cl = promote(cl)
  fs.writeFileSync(clPath, cl, 'utf8')
  say(`CHANGELOG [Unreleased] -> [${version}] - ${today}`)

  // 中文镜像同步归版——release.yml 按 [X.Y.Z] 从 CHANGELOG.zh.md 提中文段,漏归版=发布页永远只有英文(0.3.0 实锤)
  const clZhPath = path.join(ROOT, '..', 'CHANGELOG.zh.md')
  let clZh = fs.readFileSync(clZhPath, 'utf8').replace(/\r\n/g, '\n')
  const zhUnreleased = clZh.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/)
  if (!zhUnreleased) die('CHANGELOG.zh.md 缺 [Unreleased] 段——双语纪律:两份必须同版本同发布')
  if (!zhUnreleased[1].trim()) die('CHANGELOG.zh.md [Unreleased] 是空的——中文镜像没跟上英文版')
  if (clZh.includes(`## [${version}]`)) die(`CHANGELOG.zh.md 已存在 [${version}] 段——重复发版?`)
  clZh = promote(clZh)
  fs.writeFileSync(clZhPath, clZh, 'utf8')
  say(`CHANGELOG.zh.md [Unreleased] -> [${version}] - ${today}`)
}

// 4. 缓存戳 + 全量门禁(视觉第④组只在本机跑,CI 跑不了——这就是为什么 tag 前必须本机过)
say('npm run bump …')
npm(['run', 'bump'], { stdio: 'inherit' })
say('npm run check:all(数量随池内条目演进,以脚本输出汇总为准;约 4-8 分钟;中止=Ctrl+C)…')
try {
  npm(['run', 'check:all'], { stdio: 'inherit' })
} catch {
  // Best-effort rewind of exactly the files this script modified before the gate ran (version bump,
  // cache stamps, changelog section renames) so a red check:all doesn't leave a dirty tree or renamed
  // [X.Y.Z] sections that block the re-run ("CHANGELOG 已存在 [X.Y.Z] 段"). Errors are swallowed on
  // purpose: the gate failure itself is what must be reported.
  try { sh(['git', 'checkout', '--', 'package.json', 'package-lock.json', 'renderer/index.html', 'browser-dev/index.html', '../CHANGELOG.md', '../CHANGELOG.zh.md']) } catch { /* best-effort */ }
  die('check:all 未全绿——修完再跑 npm run release(不会推任何东西)')
}

// 5. 提交到隔离的 release 分支，以现有 PR/CI/分支保护完成评审。禁止直推 main/tag。
// A release candidate is NOT a published release. GitHub Publish is separately user-approved.
sh(['git', 'add', 'package.json', 'package-lock.json', 'renderer/index.html', '../CHANGELOG.md', '../CHANGELOG.zh.md'])
sh(['git', 'add', '-f', 'browser-dev/index.html'])
try {
  sh(['git', 'commit', '-m', 'chore(release): ' + TAG])
} catch (e) {
  die('提交发布候选失败，未推送分支/标签：' + ((e && e.message) || e))
}
try {
  sh(['git', 'push', '--set-upstream', 'origin', RELEASE_BRANCH])
} catch (e) {
  die('推送隔离发布分支失败，未推送 main/tag：' + ((e && e.message) || e))
}
try {
  const url = sh(['gh', 'pr', 'create', '--base', 'main', '--head', RELEASE_BRANCH,
    '--title', 'chore(release): ' + TAG, '--body',
    'Prepare ' + TAG + ' from the isolated release branch. Merge only after the required CI, review and acceptance checks. Public Release Publish requires separate explicit user approval.'])
  say('发布准备 PR：' + url)
} catch (e) {
  die('已推送发布分支但创建 PR 失败；未推送 main/tag。请重试 gh pr create，分支：' + RELEASE_BRANCH +
    '，错误：' + ((e && e.message) || e))
}

// 6. 合并门禁后才能单独打 tag (只触发 Draft 流水线，无公开 Publish)
console.log('\n发布候选 PR 已创建。等待 CI + 审核 + 合并进受保护 main 后，运行：\n  npm run release:tag ${version}\n然后查看 Draft，独立验收，取得用户明确 GO 后才可 Publish。\n')
