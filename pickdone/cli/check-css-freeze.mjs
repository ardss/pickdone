#!/usr/bin/env node
/**
 * CSS freeze gate (component-absorption refactor guardrail).
 * 全局沉积文件(style-1..4.css + theme-dark.css)只许删不许增:
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
for (const f of FILES) {
  let head = null, work = null
  try { head = execSync(`git show HEAD:${f}`, { cwd: ROOT, encoding: 'utf8' }) } catch { continue }
  try { work = execSync(`git show :${f}`, { cwd: ROOT, encoding: 'utf8' }) } catch { /* unstaged */ }
  if (work == null) {
    try { work = readFileSync(path.join(ROOT, f.slice('pickdone/'.length)), 'utf8') } catch { continue }
  }
  const h = ruleCount(head), w = ruleCount(work)
  if (w > h) {
    console.error(`  ✗ css-freeze: ${f} 规则数 ${h} → ${w}(全局沉积文件只许删不许增;新样式进组件 <style> 或 base.css)`)
    failed = true
  } else if (w < h) {
    console.log(`  ✓ css-freeze: ${f} 规则数 ${h} → ${w}(−${h - w},迁移推进)`)
  }
}
if (failed) process.exit(1)
console.log('  ✓ css-freeze 通过(全局 CSS 未增长)')
