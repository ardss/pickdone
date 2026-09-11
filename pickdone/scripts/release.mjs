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
if (!/^\d+\.\d+\.\d+$/.test(version || '')) die('用法: npm run release X.Y.Z')
const TAG = 'v' + version

// 1. 工作区干净
if (sh(['git', 'status', '--porcelain'])) die('工作区有未提交变更——先提交或清理')
say('工作区干净')

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
say('npm run check:all(29 项,约 4-8 分钟;中止=Ctrl+C)…')
try {
  npm(['run', 'check:all'], { stdio: 'inherit' })
} catch {
  // Best-effort rewind of exactly the files this script modified before the gate ran (version bump,
  // cache stamps, changelog section renames) so a red check:all doesn't leave a dirty tree or renamed
  // [X.Y.Z] sections that block the re-run ("CHANGELOG 已存在 [X.Y.Z] 段"). Errors are swallowed on
  // purpose: the gate failure itself is what must be reported.
  try { sh(['git', 'checkout', '--', 'package.json', 'renderer/index.html', 'browser-dev/index.html', '../CHANGELOG.md', '../CHANGELOG.zh.md']) } catch { /* best-effort */ }
  die('check:all 未全绿——修完再跑 npm run release(不会推任何东西)')
}

// 5. 提交 → push main → tag → push tag
// Explicit file list instead of `add -A`: these are the only files this script (and npm run bump) may
// have touched; a blanket add would sweep unrelated local debris (stray test artifacts, editor
// droppings) into the release commit. Paths are relative to ROOT (sh() cwd = pickdone/); the changelogs
// live one level above it, inside the same repo.
sh(['git', 'add', 'package.json', 'renderer/index.html', '../CHANGELOG.md', '../CHANGELOG.zh.md'])
// browser-dev/ is gitignore-listed (the tracked index.html was force-added historically) — plain add refuses it
sh(['git', 'add', '-f', 'browser-dev/index.html'])
// Anchor the pre-commit HEAD (2026-09-11 review P2): if the commit step took its "nothing to commit"
// catch branch, a blind HEAD~1 rewind would pull back the PREVIOUS unrelated commit and scatter its
// changes into the working tree. Reset to the anchor instead — a no-op unless our commit actually landed.
const preCommitHead = sh(['git', 'rev-parse', 'HEAD']).trim()
try {
  sh(['git', 'commit', '-m', `chore(release): ${TAG}`])
} catch { /* 无变更可提交也允许(stamps 可能已同笔) */ }
say('commit chore(release) 完成')
// Step-5 git-chain rollback (2026-09-11 P2): a push failure used to strand the release — the commit sat
// on local main and every re-run died on the "CHANGELOG 已存在 [X.Y.Z] 段" gate from step 2. Rewind the
// LOCAL commit (mixed: working tree keeps the renamed changelogs so nothing is re-edited) and print the
// exact recovery path. Once `push main` has succeeded, no rewind — only the tag leg may be retried.
try {
  sh(['git', 'push', 'origin', 'main'])
} catch (e) {
  const rewound = sh(['git', 'rev-parse', 'HEAD']).trim() !== preCommitHead
  if (rewound) {
    try { sh(['git', 'reset', '--mixed', preCommitHead]) } catch (e2) { console.error('自动回退 commit 失败,请手动: git reset --mixed ' + preCommitHead + ' —', e2 && e2.message) }
  }
  die(`git push main 失败(${(e && e.message) || e})。${rewound ? '已回退本地 release commit(工作区保留 CHANGELOG 归版)。' : '无 release commit 需要回退。'}
  ⚠ push 报 TLS/RPC 错误但可能已实际落远端(响应侧断连)——先核实再补救: git ls-remote origin main
  补救: ⓪若远端已有 release commit: git pull --rebase origin main 对齐,然后只重跑 git tag ${TAG} && git push origin ${TAG}
  ①否则修复网络/权限后重新 npm run release ${version}(CHANGELOG 段已归版,先手动把两份 CHANGELOG 的 [${version}] 段改回 [Unreleased],或直接恢复 [Unreleased] 标题)
  ②或仅重跑第 5 步: git push origin main && git tag ${TAG} && git push origin ${TAG}`)
}
say('main 已推送')
try {
  sh(['git', 'tag', TAG])
  sh(['git', 'push', 'origin', TAG])
} catch (e) {
  die(`tag 阶段失败(${(e && e.message) || e})。main 已推送、本地 commit 保留,勿重跑 npm run release(会撞 CHANGELOG 闸)。
  补救: ①tag 已存在: git tag -d ${TAG} && git push origin :refs/tags/${TAG} 后重试
       ②仅推送失败: git push origin ${TAG}`)
}
say(`${TAG} 已推送,Release 工作流已触发`)

// 6. 收尾指引
console.log(`
✓ 发版准备完成。接下来:
  1. 盯 Actions 的 Release 工作流(约 10 分钟;CI 自动跳过视觉第④组)
  2. 构建成功后执行: npm run release:finalize ${version}
     (自动: 从 CHANGELOG 提正文填入 draft + 核四产物 + 查空正文/重名/缺件)
  3. GitHub Releases 页面人工过目 → 点 Publish
`)
