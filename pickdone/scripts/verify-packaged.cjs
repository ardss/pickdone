#!/usr/bin/env node
/**
 * 打包产物冒烟（SOP-06 补充⑦）—— dev 全绿 ≠ 打包版能跑。
 * 校验 dist/win-unpacked 产物：
 *   1. 主程序与 app.asar 存在
 *   2. package.json build.files 白名单中每个 node_modules 顶层包在 asar 内真实存在
 *      （历史 P1：白名单漏 exceljs/node-schedule，dev 正常、打包版导出/调度当场崩）
 *   3. 关键运行时资产（vendor、vendor-lib、字体）在 asar 内
 * 用法: node scripts/verify-packaged.cjs [--dir dist/win-unpacked]
 * 依赖: 打包已执行（npm run pack）。未找到产物目录时输出 SKIP 退出 0。
 */
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(__filename)

const args = process.argv.slice(2)
const dirIdx = args.indexOf('--dir')
const unpacked = path.resolve(args[dirIdx >= 0 ? dirIdx + 1 : 0] && !args[dirIdx >= 0 ? dirIdx + 1 : 0].startsWith('--') ? args[dirIdx + 1] : 'dist/win-unpacked')

if (!fs.existsSync(unpacked)) {
  console.log('SKIP: 未找到打包产物 ' + unpacked + '（先 npm run pack）')
  process.exit(0)
}

const asarPath = path.join(unpacked, 'resources', 'app.asar')
if (!fs.existsSync(asarPath)) { console.error('FAIL: 缺 app.asar: ' + asarPath); process.exit(1) }

let asar
try { asar = req('@electron/asar') } catch { console.error('FAIL: @electron/asar 不可用（electron-builder 未安装？）'); process.exit(1) }

// asar 内文件清单（相对路径，POSIX 分隔）
const entries = asar.listPackage(asarPath).map(f => f.replace(/\\/g, '/').replace(/^\//, ''))
const entrySet = new Set(entries)

// P0 regression gate: asar 根必须有 package.json（Electron 靠它找 main，缺失=exe 秒退 code 1 零日志）；
// resources/ 根也必须有 package.json（打包版独立 CLI require('../package.json') 读版本）。
// 后者禁止用 extraResources from:package.json 实现——那会把前者从 asar 里挤掉（2026-09-03 实锤）。
if (!entrySet.has('package.json')) { console.error('FAIL: app.asar 根缺 package.json（打包版 exe 会秒退）;extraResources 禁用 from:package.json 条目'); process.exit(1) }
const resPkg = path.join(unpacked, 'resources', 'package.json')
if (!fs.existsSync(resPkg)) { console.error('FAIL: 缺 resources/package.json（打包版 CLI version/doctor 依赖它）'); process.exit(1) }

// 随包资产门禁：SKILL.md 会经 skill install 原样写进用户 ~/.zcode、~/.claude——含 C0 控制字符会教唆 AI 执行损坏命令
// （D:\backups 曾烂成 D:+0x08+ackups，2026-09-03 实锤）；.cmd shim 必须 CRLF+纯 ASCII+无 BOM，否则 cmd.exe 解析炸（LF/中文注释实锤过）
const resCli = path.join(unpacked, 'resources', 'cli')
if (fs.existsSync(resCli)) {
  const skillBuf = fs.readFileSync(path.join(resCli, 'SKILL.md'))
  const ctrl = [...skillBuf].filter(b => b < 9 || (b > 13 && b < 32))
  if (ctrl.length) { console.error(`FAIL: resources/cli/SKILL.md 含 ${ctrl.length} 个 C0 控制字符（skill install 会原样扩散）`); process.exit(1) }
  const cmdBuf = fs.readFileSync(path.join(unpacked, 'resources', 'bin', 'pickdone.cmd'))
  if (cmdBuf[0] === 0xef && cmdBuf[1] === 0xbb && cmdBuf[2] === 0xbf) { console.error('FAIL: pickdone.cmd 带 UTF-8 BOM（cmd.exe 解析炸）'); process.exit(1) }
  if ([...cmdBuf].some(b => b > 127)) { console.error('FAIL: pickdone.cmd 含非 ASCII 字节（cmd.exe 按 ANSI 解读会乱码）'); process.exit(1) }
  const txt = cmdBuf.toString('latin1')
  if (/(^|[^\r])\n/.test(txt)) { console.error('FAIL: pickdone.cmd 含裸 LF（cmd.exe 只认 CRLF）'); process.exit(1) }
}

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
const globs = pkg.build && pkg.build.files || []

// 从白名单 glob 提取包名（支持 @scope/pkg 作用域形式）
const wantedPkgs = new Set()
for (const g of globs) {
  const m = g.match(/^node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*)(?:\/.*)?$/)
  if (m) wantedPkgs.add(m[1])
}

const typeOnly = []
const missing = []
for (const pkgName of [...wantedPkgs].sort()) {
  if (pkgName.startsWith('@types/')) { typeOnly.push(pkgName); continue } // 纯 .d.ts 类型包，无运行时代码，打包器合法排除
  // 通用 types-only 判定：包声明了 types 且无 main（如 undici-types，@types/node 的传递依赖）同样无运行时形态
  try {
    const pp = JSON.parse(fs.readFileSync(path.resolve('node_modules', pkgName, 'package.json'), 'utf8'))
    if (pp.types && !pp.main) { typeOnly.push(pkgName); continue }
  } catch { /* 读不到按运行时包对待，交给缺失判定 */ }

  // 包文件存在于 node_modules 下任意深度即可——npm 提升策略会把传递依赖嵌进宿主包内
  // （实例：async-validator 被收进 node_modules/element-plus/node_modules/ 下）
  const needle = '/' + pkgName + '/'
  const hit = [...entrySet].some(e => e.startsWith('node_modules/' + pkgName)) || [...entrySet].some(e => e.includes(needle))
  if (!hit) missing.push(pkgName)
}

// 关键运行时资产（vendor 已移出 asar：driver 走 extraResources resources/vendor，下方单独校验）
const mustAssets = ['assets/vendor-lib', 'assets/fonts', 'assets/img']
const missingAssets = mustAssets.filter(a => ![...entrySet].some(e => e.startsWith(a)))

// vendor driver 校验移到 unpacked resources 层：app 与打包 CLI 都从 resources/vendor 加载
// （2026-09-11 Linux 实锤：asar 内副本被 electron-builder 按 arch 智能剪枝，arm64 包里只剩
// win32-x64.node → DB 初始化失败。resources/vendor 是 extraResources 全量副本，含全平台 prebuild）
const platMap = { win32: 'win32', linux: 'linux', darwin: 'darwin' }
const archMap = { x64: 'x64', arm64: 'arm64' }
const platformPrebuild = `prebuilds/${platMap[process.platform]}-${archMap[process.arch]}.node`
const vendorPrebuilds = path.join('dist', process.platform === 'win32' ? 'win-unpacked' : `${process.platform}-unpacked`, 'resources', 'vendor', 'better-sqlite3-multiple-ciphers', platformPrebuild)
if (!fs.existsSync(vendorPrebuilds)) {
  console.error(`FAIL: ${vendorPrebuilds} 不存在（resources/vendor 驱动副本缺本平台 prebuild，打包版 DB 初始化必失败）`)
  process.exit(1)
}

// 逐文件校验：两个 index.html 引用的每个 assets/ 静态文件必须真实在 asar 内
// （历史 P1 模式：目录前缀检查发现不了单文件缺失——driver.css 白名单漏 glob 即此形态）
const perFileMissing = []
// 入口 html 本体必须在 asar 内(白名单目录级检查查不出入口缺失)
if (!entrySet.has('renderer-dist/index.html')) {
  console.error('FAIL: renderer-dist/index.html 未进入 asar(渲染层入口缺失,打包版白屏)')
  process.exit(1)
}
const htmlEntries = ['renderer-dist/index.html']
if (fs.existsSync(path.resolve('browser-dev/index.html'))) htmlEntries.push('browser-dev/index.html')
else console.log('[verify] browser-dev/index.html not present (gitignored on clean clones) — skipping browser-dev host check')
for (const htmlPath of htmlEntries) {
  const html = fs.readFileSync(path.resolve(htmlPath), 'utf8')
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    let ref = m[1].split('?')[0]
    if (/^(https?:|data:|#)/.test(ref)) continue
    ref = ref.replace(/^app:\/\/app\//, '').replace(/^\//, '')
    // 只校验静态引用;Electron 宿主的 Vite hash 资产(renderer-dist/assets/*)与 app 资产逐文件核对
    // browser-dev 是开发宿主(不走 asar),仅校验其共享 assets 引用
    if (htmlPath !== 'renderer-dist/index.html' && !ref.startsWith('assets/')) continue
    if (!(ref.startsWith('assets/') || ref.startsWith('renderer-dist/'))) continue
    if (!entrySet.has(ref)) perFileMissing.push(`${htmlPath} → ${ref}`)
  }
}

if (missing.length) {
  console.error('FAIL: 白名单内以下包未进入 asar（打包版必崩源）:\n  ' + missing.join('\n  '))
  process.exit(1)
}
if (missingAssets.length) {
  console.error('FAIL: 关键资产缺失: ' + missingAssets.join(', '))
  process.exit(1)
}
if (perFileMissing.length) {
  console.error('FAIL: index.html 引用的本地文件未进入 asar（单文件缺失，目录级检查查不出）:\n  ' + perFileMissing.join('\n  '))
  process.exit(1)
}
// 发布三件套对账：latest.yml 声明的 sha512/size 必须与同目录 exe 实测一致（重打包后只拷部分文件即发出=用户更新失败/增量下载损坏）
try {
  const ymlPath = path.resolve('dist/latest.yml')
  if (fs.existsSync(ymlPath)) {
    const crypto = require('node:crypto')
    const yml = fs.readFileSync(ymlPath, 'utf8')
    const urlM = yml.match(/- url:\s*(\S+)/)
    const shaM = yml.match(/sha512:\s*(\S+)/)
    const sizeM = yml.match(/size:\s*(\d+)/)
    if (urlM && shaM && sizeM) {
      const exePath = path.join(path.dirname(ymlPath), urlM[1])
      if (!fs.existsSync(exePath)) { console.error('FAIL: latest.yml 指向的 ' + urlM[1] + ' 不存在于 dist/（发布三件套不齐）'); process.exit(1) }
      const buf = fs.readFileSync(exePath)
      const actualSha = crypto.createHash('sha512').update(buf).digest('base64')
      if (actualSha !== shaM[1] || buf.length !== Number(sizeM[1])) {
        console.error(`FAIL: latest.yml 与 ${urlM[1]} 实测不符（sha512 ${actualSha === shaM[1] ? '一致' : '不一致'} / size ${buf.length} vs ${sizeM[1]}）——重打包后未同步重生成元数据`)
        process.exit(1)
      }
      console.log('OK: latest.yml ↔ ' + urlM[1] + ' sha512/size 对账一致')
    }
  } else {
    console.log('[verify] dist/latest.yml 不存在——跳过发布三件套对账（仅打包不发布时可忽略）')
  }
} catch (e) { console.error('FAIL: latest.yml 对账异常: ' + e.message); process.exit(1) }

console.log(`OK: asar 含白名单运行时包 ${wantedPkgs.size - typeOnly.length} 个（另跳过 @types 类型包 ${typeOnly.length} 个）、关键资产齐全 + 双 index.html 逐文件引用全部命中，共 ${entries.length} 项`)
