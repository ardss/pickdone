#!/usr/bin/env node
/* eslint-env node */
/**
 * CSS freeze gate (component-absorption refactor guardrail).
 * 全局沉积文件(theme-dark.css;style-1..4 已于 2026-09 退役)只许删不许增:
 *   括号数(≈规则数)工作区/暂存版不得多于 git HEAD;迁移批次从全局文件删规则搬进 SFC,天然通过。
 * 需要新增共享样式时,唯一出口是 base.css(token/骨架)或组件自身的 <style> 块。
 * 临时豁免: 环境变量 CSS_FREEZE_OFF=1(仅限当次命令,台账须注明理由)。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CSS_FREEZE_OFF === '1') { console.log('  (css-freeze) CSS_FREEZE_OFF=1 跳过本次'); process.exit(0) }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['theme-dark.css'].map(f => 'pickdone/assets/css/' + f)

const ruleCount = css => (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) || []).length

let failed = false
let compared = 0
const existsInHead = f => {
  try { execSync(`git cat-file -e HEAD:${f}`, { cwd: ROOT, stdio: 'ignore' }); return true } catch { return false }
}
for (const f of FILES) {
  let head = null, work = null
  try {
    head = execSync(`git show HEAD:${f}`, { cwd: ROOT, encoding: 'utf8' })
  } catch (e) {
    // Fail closed: a registered file missing from HEAD is a red, and any other git error is a red too —
    // never let the scan surface collapse to zero and still print green (same policy as cli/check-tokens.js).
    if (!existsInHead(f)) console.error(`  ✗ css-freeze: ${f} 不在 git HEAD 中（登记文件被删/改名,须更新本门禁 FILES）`)
    else console.error(`  ✗ css-freeze: 读取 ${f} 的 HEAD 版本失败（${String(e.message).split('\n')[0]}）—— 瞬时 git 错误也按红处理,重跑或人工核查`)
    failed = true
    continue
  }
  try {
    work = execSync(`git show :${f}`, { cwd: ROOT, encoding: 'utf8' })
  } catch { /* unstaged: fall through to worktree */ }
  if (work == null) {
    try {
      work = readFileSync(path.join(ROOT, f.slice('pickdone/'.length)), 'utf8')
    } catch (e) {
      console.error(`  ✗ css-freeze: HEAD:${f} 存在但工作区/暂存区均读不到（${String(e.message).split('\n')[0]}）`)
      failed = true
      continue
    }
  }
  compared++
  const h = ruleCount(head), w = ruleCount(work)
  if (w > h) {
    console.error(`  ✗ css-freeze: ${f} 规则数 ${h} → ${w}(全局沉积文件只许删不许增;新样式进组件 <style> 或 base.css)`)
    failed = true
  } else if (w < h) {
    console.log(`  ✓ css-freeze: ${f} 规则数 ${h} → ${w}(−${h - w},迁移推进)`)
  }
}
if (failed) process.exit(1)
console.log(`  ✓ css-freeze 通过(${compared}/${FILES.length} 个登记文件完成比较,全局 CSS 未增长)`)
