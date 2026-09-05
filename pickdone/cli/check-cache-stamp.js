#!/usr/bin/env node
/**
 * Cache-stamp discipline gate — renderer/index.html 的 ?v= 戳是 app:// 静态资源(immutable 缓存)的唯一失效手段。
 * 事故形态(2026-09-05 实锤):改了 assets/css/*.css 却没 bump 戳,连续 3 笔提交漏 bump,发版后已装用户改动永不生效。
 * 规则:任何 assets/css/** 的提交时间晚于 renderer/index.html 最后一次提交 = FAIL;工作区有未提交的 css 改动同样 FAIL(要求与 bump 同笔提交)。
 * 注:SFC/renderer/js 改动走 vite 哈希产物,不需要 bump——本门禁只管 index.html 里带 ?v= 的直引资源。
 */
const { execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const dirty = git(['status', '--porcelain', '--', 'assets/css']).split('\n').filter(Boolean)
if (dirty.length) {
  console.error('✗ 缓存戳纪律:assets/css 有未提交改动——改 css 必须同笔提交 bump renderer/index.html 的 ?v= 戳:\n  ' + dirty.join('\n  '))
  process.exit(1)
}

const tsOf = (spec) => Number(git(['log', '-1', '--format=%ct', '--', spec])) || 0
const htmlTs = tsOf('renderer/index.html')
const cssFiles = git(['ls-files', 'assets/css']).split('\n').filter(f => /\.(css|woff2?|ttf|svg|png)$/i.test(f))
const stale = cssFiles.filter(f => tsOf(f) > htmlTs)
if (!htmlTs) { console.log('✓ 缓存戳:renderer/index.html 无提交历史(非 git 环境?),跳过'); process.exit(0) }
if (stale.length) {
  console.error('✗ 缓存戳纪律:以下资源在 renderer/index.html 最后一次修改之后又被改过,但 ?v= 戳未 bump——发版后已装用户将拿到旧缓存(immutable):\n  ' + stale.join('\n  ') + '\n  修复:改 renderer/index.html 的 ?v= 时间戳并随包发布')
  process.exit(1)
}
console.log('✓ 缓存戳纪律(' + cssFiles.length + ' 个直引资源全部早于或同于最后一次 index.html 提交)')
