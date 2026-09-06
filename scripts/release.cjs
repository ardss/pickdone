#!/usr/bin/env node
/** 一键发布脚本：校验分支/工作区 → 门禁（check:all）→ bump 版本 → 提交 → 打 tag → push（tag 触发 CI 构建 Draft Release）
 *  用法：
 *    node scripts/release.cjs            # bump patch（0.2.0 -> 0.2.1）
 *    node scripts/release.cjs minor      # bump minor
 *    node scripts/release.cjs major      # bump major
 *    node scripts/release.cjs 0.3.0      # 指定版本号
 *    node scripts/release.cjs --dry-run  # 只跑预检与门禁，打印将执行的动作后退出（不写任何文件/提交）
 *  CI 完成后：到 GitHub Releases 把 Draft 补 changelog 并 Publish，用户端才会收到更新。
 *  半完成态恢复指引见各失败分支输出。
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const appDir = path.join(root, 'pickdone')
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' })

const DRY_RUN = process.argv.includes('--dry-run')
const arg0 = process.argv.slice(2).find(a => !a.startsWith('--')) || 'patch'

// 0. 分支断言：发布只允许从 main 发起（tag 触发的 CI 以 main 为基线，避免从修复分支打出漂移版本）
const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim()
if (branch !== 'main') {
  console.error(`✗ 当前分支为 ${branch}，发布必须在 main 上执行。处理：git checkout main && git pull 后重跑`)
  process.exit(1)
}

// 1. 已跟踪文件必须干净（版本提交不能混入未审改动；untracked 不进提交，不拦）
let dirty = ''
try { dirty = execSync('git status --porcelain --untracked-files=no', { cwd: root, encoding: 'utf8' }).trim() } catch {}
if (dirty) { console.error('✗ 工作区有未提交改动，先提交/清理：\n' + dirty); process.exit(1) }

// 1.5 质量门禁前移：打 tag 前先跑 check:all（lint+指纹+license+token+i18n+测试+smoke），
//     失败即中止——此时还没 bump/提交/tag，工作区零污染，无需恢复步骤
console.log('▶ 运行质量门禁 npm run check:all ...')
try { sh('npm run check:all', appDir) } catch (e) {
  console.error('✗ check:all 未通过，已中止发布（未 bump/未提交/未打 tag，无需恢复）。先修复门禁问题再重跑')
  process.exit(1)
}
if (DRY_RUN) {
  const v = (() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
    let [maj, min, pat] = pkg.version.split('.').map(Number)
    if (/^\d+\.\d+\.\d+$/.test(arg0)) return arg0
    if (arg0 === 'major') return `${maj + 1}.0.0`
    if (arg0 === 'minor') return `${maj}.${min + 1}.0`
    return `${maj}.${min}.${pat + 1}`
  })()
  // dry-run 也做 tag 残留预检:否则"目标tag已存在"这一失败面不在 dry-run 覆盖内
  let tagSha = ''
  try { tagSha = execSync(`git rev-parse -q --verify refs/tags/v${v}`, { cwd: root }).toString().trim() } catch {}
  if (tagSha) {
    console.error(`✗ [dry-run] tag v${v} 已存在，正式发布会在此失败。处理：git tag -d v${v} 后重跑`)
    process.exit(1)
  }
  console.log(`[dry-run] 门禁通过。将执行：bump → v${v}；commit "release: v${v}"；git tag v${v}；git push origin main；git push origin v${v}`)
  process.exit(0)
}

// 2. 计算新版本
const pkgPath = path.join(appDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const arg = arg0
let [maj, min, pat] = pkg.version.split('.').map(Number)
let version
if (/^\d+\.\d+\.\d+$/.test(arg)) version = arg
else if (arg === 'major') version = `${maj + 1}.0.0`
else if (arg === 'minor') version = `${maj}.${min + 1}.0`
else if (arg === 'patch') version = `${maj}.${min}.${pat + 1}`
else { console.error('✗ 参数须为 patch|minor|major 或 x.y.z'); process.exit(1) }

// 3. tag 残留预检：存在即明确报错，避免半完成态
let tagSha = ''
try { tagSha = execSync(`git rev-parse -q --verify refs/tags/v${version}`, { cwd: root }).toString().trim() } catch {}
if (tagSha) {
  console.error(`✗ tag v${version} 已存在。处理：git tag -d v${version} 后重跑；或直接 git push origin v${version} 复用`)
  process.exit(1)
}

// 4. bump（package.json + package-lock 根 version 同步，防漂移）
const lockPath = path.join(appDir, 'package-lock.json')
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
if (lock.version !== undefined) lock.version = version
if (lock.packages && lock.packages['']) lock.packages[''].version = version
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
sh('git add pickdone/package.json pickdone/package-lock.json')
sh(`git commit -m "release: v${version}"`)
sh(`git tag "v${version}"`)

// 5. 推送（任一步失败给出对应恢复指引）
try {
  sh('git push origin main')
} catch (e) {
  console.error(`✗ push main 失败：bump 提交仅在本地。恢复：git reset --hard HEAD~1 && git tag -d v${version}`)
  process.exit(1)
}
try {
  sh(`git push origin "v${version}"`)
} catch (e) {
  console.error(`✗ push tag 失败（main 已更新）。恢复：直接执行 git push origin v${version}`)
  process.exit(1)
}

console.log(`
✅ 已推送 v${version}。收尾两步：
  1. 等 GitHub Actions（https://github.com/ardss/pickdone/actions）构建完成；
  2. 到 https://github.com/ardss/pickdone/releases 把 Draft Release 补上 changelog 后点 Publish
     （Publish 前 electron-updater 检测不到，Publish 后已装用户启动即收到更新）。
`)
