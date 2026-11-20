#!/usr/bin/env node
/* 版本一致性门禁 —— package.json 与 package-lock.json 必须报同一个版本。
 *
 * 为什么需要一条独立门禁（2026-11-21）：beta.41 是手工改 package.json 版本号打的包，
 * lockfile 忘了一起改，停在 beta.40。而 cli/check-test-scope.cjs 的「版本中性化」把两个
 * 文件都判成了无害：
 *   - package.json：只差 version 字段 → 中性
 *   - package-lock.json：**完全没改动** → 中性（lockVersionOnly 的 staged===head 分支）
 * 于是提交门禁把单测阶段整个跳过了，版本漂移只被 P1-4h 这条单测发现——而那条单测正好
 * 被同一个门禁 DEFERRED 掉了。绿灯、漂移、无人知晓。
 *
 * 这条门禁不依赖任何测试运行：读两个文件，比三个字段，不一致就红。毫秒级，适合放进
 * pre-commit 和 CI 静态阶段。
 *
 * 用法：
 *   node cli/check-version-consistency.cjs            # 读工作区文件
 *   node cli/check-version-consistency.cjs --staged   # 读 index blob（部分暂存时才是真相）
 *   node cli/check-version-consistency.cjs --dir=DIR  # 读指定目录（自测/夹具用）
 *
 * 退出码：0 一致（或无 lockfile，跳过），1 不一致/不可解析。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const APP_ROOT = path.resolve(__dirname, '..') // pickdone/
const REPO_ROOT = path.resolve(APP_ROOT, '..')

const args = process.argv.slice(2)
const staged = args.includes('--staged')
const dirArg = (args.find(a => a.startsWith('--dir=')) || '').slice('--dir='.length)
const manifestDir = dirArg ? path.resolve(dirArg) : APP_ROOT

/** 读一个清单的原始文本。--staged 时按 index blob 读（`:0:` = 已解决的冲突态），
 *  路径必须是仓库根相对的 `pickdone/...`：工作树根目录另有一个 workspace package.json，
 *  裸 `:0:package.json` 会静默读到错的文件（与 check-test-scope.cjs 同款坑）。 */
function readManifest (name) {
  if (staged && !dirArg) {
    try {
      return execFileSync('git', ['show', `:0:pickdone/${name}`], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return null // 未暂存 → 回落到工作区，让门禁看提交后的真实状态
    }
  }
  try {
    return fs.readFileSync(path.join(manifestDir, name), 'utf8')
  } catch {
    return null
  }
}

function parse (raw, name) {
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    console.error(`✗ 版本一致性: ${name} 不是合法 JSON —— ${e.message}`)
    process.exit(1)
  }
}

const pkgRaw = readManifest('package.json')
const lockRaw = readManifest('package-lock.json')
const pkg = parse(pkgRaw, 'package.json')
const lock = parse(lockRaw, 'package-lock.json')

if (!pkg) {
  // 两个清单都不存在 = 这不是应用仓库（hook 夹具、别的 git 仓库调用同一个钩子）→ 没东西可查。
  // 只缺 package.json 却留着 lockfile 才是异常态（删了清单没删 lock）→ 仍然 fail-closed。
  if (!lockRaw) {
    console.log('✓ 版本一致性: 无清单文件，跳过')
    process.exit(0)
  }
  console.error('✗ 版本一致性: 读不到 package.json，但 package-lock.json 存在 —— 拒绝放行')
  process.exit(1)
}
if (!lock) {
  // 没有 lockfile 的安装方式（个别只读/无网环境）不该被这条门禁误伤；
  // 但只要 lockfile 存在，就必须一致。
  console.log('✓ 版本一致性: 无 package-lock.json，跳过')
  process.exit(0)
}

const pkgVersion = pkg.version
const lockRoot = lock.version
const lockPkg = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined

const problems = []
if (!pkgVersion) problems.push('package.json 缺 version 字段')
if (lockRoot !== pkgVersion) problems.push(`package-lock.json version=${lockRoot} ≠ package.json version=${pkgVersion}`)
if (lockPkg !== pkgVersion) problems.push(`package-lock.json packages[""].version=${lockPkg} ≠ package.json version=${pkgVersion}`)

if (problems.length) {
  console.error('✗ 版本一致性: package.json 与 package-lock.json 版本号不一致')
  for (const p of problems) console.error(`    - ${p}`)
  console.error('  修复（二选一）：')
  console.error(`    cd pickdone && npm version ${pkgVersion} --no-git-tag-version --allow-same-version`)
  console.error(`    手动把 package-lock.json 的两处 version 改成 ${pkgVersion}`)
  console.error('  为什么拦：只改一侧时 check-test-scope 会把两个清单都判为"版本中性"，单测阶段被整体跳过，')
  console.error('           漂移只能靠 P1-4h 单测发现——而那条单测正是被同一个门禁 DEFERRED 的。')
  process.exit(1)
}

console.log(`✓ 版本一致性: ${pkgVersion}（package.json = lock.version = packages[""].version）`)
