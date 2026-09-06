#!/usr/bin/env node
/**
 * CSSOM 完整性门禁 —— 「浏览器解析后的规则数」对照「磁盘入库基线」。
 * 背景：CSSOM 错误恢复会静默吞规则（两次实锤：头注释内嵌星号斜杠被提前闭合吞掉 .tomato-record、
 * 裸控制字符吞掉 .modal-container），磁盘文本检查与 console 均零信号。
 * 机制：自拉起隔离实例 → 读 document.styleSheets 每个样式表的规则数 → 对照
 * tests/cssom-baseline.json（≥95% 通过；样式表缺失或计数 0 直接红）。
 * 用法:
 *   node tests/run-interactions-gated.mjs tests/cssom-integrity.mjs        （门禁模式，check:all 调用）
 *   node tests/cssom-integrity.mjs --update                                （刷新基线；重构合法增删规则后手动执行）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnApp, stopApp, connectCdp, evalJson, sleep } from './lib/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(HERE, 'cssom-baseline.json')
const UPDATE = process.argv.includes('--update')

const script = `(() => {
  const out = []
  for (const ss of document.styleSheets) {
    if (!ss.href) {
      // 组件运行时注入的<style>(无href):按ownerNode.id登记——与磁盘CSS同受CSSOM静默吞规则威胁,
      // 原先完全不在基线内(2026-09-02审查实锤的覆盖缺口)
      const id = ss.ownerNode && ss.ownerNode.id
      if (!id) continue
      let n0 = 0
      try { n0 = ss.cssRules.length } catch { n0 = -1 }
      out.push(['[inject:' + id + ']', n0])
      continue
    }
    let name = (ss.href.split('/').pop() || '').split('?')[0]
    if (!name.endsWith('.css')) continue
    let n = 0
    try { n = ss.cssRules.length } catch { n = -1 }
    out.push([name, n])
  }
  return JSON.stringify(out)
})()`

let ctx
try {
  ctx = await spawnApp({ name: 'cssom' })
  await connectCdp(ctx)
  await evalJson(ctx, '1') // warm-up
  await sleep(1200)
  // Node 侧归一(双保险:页面侧同名规则在模板字符串里,这里兜底)——改样式→哈希变→基线失效的跑步机根治
  const normName = n => /^index-[\w-]+\.css$/.test(n) ? 'index-built.css' : n
  const sheets = JSON.parse(await evalJson(ctx, script)).map(([n, c]) => [normName(n), c])
  const live = Object.fromEntries(sheets)

  if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(live, null, 2) + '\n')
    console.log('[cssom] baseline updated:', JSON.stringify(live))
    process.exit(0)
  }

  if (!fs.existsSync(BASELINE)) {
    // 基线已入库（tests/cssom-baseline.json），缺失=克隆不完整或文件被删——按事故形态判 FAIL 而非静默 SKIP（SKIP=exit 0 是假绿）
    console.error('[cssom] FAIL —— 基线缺失: ' + BASELINE + '（重建: node tests/cssom-integrity.mjs --update）')
    process.exit(1)
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))

  const problems = []
  for (const [name, n] of sheets) {
    const base = baseline[name]
    if (base === undefined) { problems.push(`${name}: 不在基线中（新样式表？执行 --update 刷新基线）`); continue }
    if (n === -1) { problems.push(`${name}: CSSOM 访问被拒`); continue }
    if (n < base * 0.95) problems.push(`${name}: CSSOM 规则数 ${n} < 基线 ${base}×95% —— 存在被静默吞掉的规则块`)
  }
  for (const name of Object.keys(baseline)) {
    if (!(name in live)) problems.push(`${name}: 页面未加载该样式表`)
  }
  if (problems.length) {
    console.error('[cssom] FAIL —— 规则被静默吞掉的事故形态:\n  ' + problems.join('\n  '))
    process.exit(1)
  }
  console.log(`[cssom] OK: ${sheets.length} 个样式表全部 ≥ 基线 95%`)
  process.exit(0)
} catch (e) {
  console.error('[cssom] FAIL:', e.message)
  process.exit(1)
} finally {
  if (ctx) await stopApp(ctx).catch(() => {})
}
