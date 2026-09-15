#!/usr/bin/env node
/**
 * Cache-stamp discipline gate — renderer/index.html 的 ?v= 戳是 app:// 静态资源(immutable 缓存)的唯一失效手段。
 * 事故形态(2026-09-05 实锤):改了 assets/css/*.css 却没 bump 戳,连续 3 笔提交漏 bump,发版后已装用户改动永不生效。
 * 规则:任何 assets/css/** 或 assets/vendor-lib/** 的提交时间晚于 renderer/index.html 最后一次提交 = FAIL;
 *       工作区有未提交的改动同样 FAIL(要求与 bump 同笔提交)。
 * 注:SFC/renderer/js 改动走 vite 哈希产物,不需要 bump——本门禁只管 index.html 直引的静态资源(css/vendor-lib)。
 *
 * 豁免清单(2026-09-15 登记):index.html 直引但【无 ?v= 戳】的资源,本门禁对其 stale 报警视为人工豁免,
 * 第三方冻结 vendor 原则上不改;若确需升级,必须人工 bump(给 index.html 该行补/更新 ?v= 后再提交):
 *   - assets/vendor-lib/element-plus/index.css
 *   - assets/vendor-lib/driver.css
 *   - assets/vendor-lib/driver.iife.js
 *   - assets/vendor-lib/vue-i18n.global.prod.js
 *   - assets/vendor-lib/element-plus/locale-zh-cn.min.js
 *   - assets/vendor-lib/element-plus/locale-en.min.js
 *   - assets/vendor-lib/pinyin-pro.umd.js
 *   - assets/vendor-lib/dayjs.min.js
 *   - assets/vendor-lib/dayjs-plugin-isoWeek.js
 *   - assets/img/favicon.svg
 *   - assets/favicon.ico
 */
const { execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const WATCHED = ['assets/css', 'assets/vendor-lib']
const ASSET_EXT = /\.(css|js|mjs|woff2?|ttf|svg|png|ico)$/i
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const dirty = git(['status', '--porcelain', '--', ...WATCHED]).split('\n').filter(Boolean)
if (dirty.length) {
  // 资源与 index.html 同处改动/暂存态 = bump 与改动同笔在途,放行(门禁语义「同笔提交」的前置形态);
  // 只有资源改了而 index.html 没动才是真违规
  const htmlDirty = git(['status', '--porcelain', '--', 'renderer/index.html']).trim().length > 0
  if (!htmlDirty) {
    console.error('✗ 缓存戳纪律:assets/css 或 assets/vendor-lib 有改动但 renderer/index.html 未同步 bump——改直引资源必须同笔提交 ?v= 戳:\n  ' + dirty.join('\n  '))
    process.exit(1)
  }
}

const tsOf = (spec) => Number(git(['log', '-1', '--format=%ct', '--', spec])) || 0
const htmlTs = tsOf('renderer/index.html')
const assetFiles = git(['ls-files', ...WATCHED]).split('\n').filter(f => ASSET_EXT.test(f))
const stale = assetFiles.filter(f => tsOf(f) > htmlTs)
if (!htmlTs) { console.log('✓ 缓存戳:renderer/index.html 无提交历史(非 git 环境?),跳过'); process.exit(0) }
if (stale.length) {
  console.error('✗ 缓存戳纪律:以下资源在 renderer/index.html 最后一次修改之后又被改过,但 ?v= 戳未 bump——发版后已装用户将拿到旧缓存(immutable):\n  ' + stale.join('\n  ') + '\n  修复:改 renderer/index.html 的 ?v= 时间戳并随包发布(无 ?v= 的直引资源见脚本头部豁免清单,升级需人工 bump)')
  process.exit(1)
}
console.log('✓ 缓存戳纪律(' + assetFiles.length + ' 个直引资源全部早于或同于最后一次 index.html 提交)')
