#!/usr/bin/env node
/**
 * a11y auto scan (SOP-04 automation) — injects axe-core into the running App and reports violations
 * Usage: node cli/a11y-scan.js [route, default #/todo-list] (App must run in CDP mode, same prerequisites as e2e)
 * Rule: critical/serious violations exit non-zero; moderate is listed only
 */
const path = require('path')
const fs = require('fs')
const { sleep, getJSON, cdpConnect } = require('./lib-cdp-client.cjs')

const PORT = 9444 // 9333 falls inside a Windows reserved port range (9292-9391) and gets swallowed; standardized on the project port 9444
const ROUTE = process.argv[2] || '#/todo-list'

async function main () {
  const list = await getJSON(PORT, '/json/list').catch(() => { throw new Error('App 未在 CDP 模式运行（参考 cli/ui-smoke.js 的锁诊断）') })
  const page = list.find(t => t.type === 'page' && t.url.includes('#/todo-list'))
  if (!page) throw new Error('未找到主窗口 target')
  const { send, evalJS, open } = cdpConnect(page.webSocketDebuggerUrl)
  await open

  await send('Page.enable')
  await evalJS(`location.hash = ${JSON.stringify(ROUTE)}; "ok"`)
  await sleep(7000)

  // Inject axe-core (already in devDependencies)
  const axeSrc = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8')
  await send('Runtime.evaluate', { expression: axeSrc })
  // top-level await is illegal in Runtime.evaluate; must wrap in an async IIFE (awaitPromise:true does the waiting)
  const raw = await evalJS(`(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] })
    return JSON.stringify({ violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length,
      sample: v.nodes.slice(0, 2).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\\n')[0].slice(0, 120)) })) })
  })()`)
  if (process.env.A11Y_DUMP) require('fs').writeFileSync(process.env.A11Y_DUMP, raw)
  const result = JSON.parse(raw)

  const serious = result.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')
  console.log(`路由 ${ROUTE}：${result.violations.length} 类违规（critical/serious: ${serious.length}）`)
  result.violations.forEach(v => {
    console.log(`  [${v.impact}] ${v.id} × ${v.nodes} 处`)
    v.sample.forEach(s => console.log('      ' + s))
  })
  if (serious.length) { console.error(`\n✗ ${serious.length} 类 critical/serious 违规，发布阻塞`); process.exit(1) }
  console.log('\n✓ 无 critical/serious 违规')
  process.exit(0) // the pass path must also exit explicitly: the open WebSocket hangs the process (looks like a "stuck" scan)
}
main().catch(e => { console.error('扫描失败:', e.message); process.exit(1) })
