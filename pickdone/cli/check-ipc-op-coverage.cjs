/**
 * IPC op coverage gate — statically cross-checks three-way consistency:
 *   (1) The full set of ops from the renderer's dbCall / dbCall?.( ⊆ index.js ALLOWED_RENDERER_OPS whitelist
 *       (two missed checks once silently broke features entirely: filterList broke filters, bumpSnow broke pomodoro credit — errors were swallowed by .catch with no UI error)
 *   (2) Every whitelisted op truly exists in db.js OPS (guards against dead entries whose call would throw "unknown operation")
 * Run: node cli/check-ipc-op-coverage.cjs (wired into check:all)
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
let failed = 0
const bad = m => { console.error('  ✗ ' + m); failed++ }
const ok = m => console.log('  ✓ ' + m)

function walk (dir, acc) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.js') || p.endsWith('.vue')) acc.push(p)
  }
  return acc
}

const idxSrc = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8')
const wlMatch = idxSrc.match(/ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
if (!wlMatch) { bad('index.js 中找不到 ALLOWED_RENDERER_OPS'); process.exit(1) }
const allowed = new Set([...wlMatch[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]))

// Renderer call surface: both dbCall('op' and dbCall?.('op' forms must be captured (the optional-chain form was once missed).
// ledgerWrite('op' 必须同扫:账本写全走 store/tomato.js 的 ledgerWrite 变量包装,只扫 dbCall 会令账本写面对门禁整体隐身
// (新增 ledgerWrite op 忘加白名单=主进程 throw+catch 吞掉=静默全断,2026-09-04 并行审查 F8 实锤盲区)
const used = new Map() // op -> first file it appears in
for (const f of walk(path.join(root, 'renderer/js'), [])) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/(?:dbCall(?:\?\.)?|ledgerWrite)\(\s*'([A-Za-z]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], path.relative(root, f))
  }
}

// (1) Every op used by the renderer must be on the whitelist
for (const [op, file] of [...used].sort()) {
  if (!allowed.has(op)) bad(`渲染端调用 op "${op}"（${file}）不在 ALLOWED_RENDERER_OPS —— 该功能此刻正静默全断`)
}
ok(`渲染端调用面 ${used.size} 个 op 全部在白名单内`)

// (2) Every whitelisted op must exist in db.js OPS
const dbSrc = fs.readFileSync(path.join(root, 'src/main/db.js'), 'utf8')
const opsMatch = dbSrc.match(/\nconst OPS = \{([\s\S]*?)\n\}/)
if (!opsMatch) { bad('db.js 中找不到 OPS 表'); process.exit(1) }
// OPS 键用 [A-Za-z_]:下划线内部键(_recToRow 等)虽不应进白名单,但正则漏识别会造成误报方向失真;同行键 `}, key:` 形状由格式约定禁止(批1曾实锤漏检 tomatoRemoveByIds,已换行)
const dbOps = new Set([...opsMatch[1].matchAll(/^ {2}([A-Za-z_]+)(?::|,)/gm)].map(x => x[1]))
for (const op of allowed) {
  if (!dbOps.has(op)) bad(`白名单 op "${op}" 在 db.js OPS 中不存在（死条目，调用即抛未知操作）`)
}
ok(`白名单 ${allowed.size} 个 op 全部存在于 db.js OPS`)

// (3) Dedicated dangerous channels must exist in handlers and carry the main-window guard
for (const ch of ['db:purge-recycle-bin', 'db:purge-seed-todos']) {
  if (!idxSrc.includes(`'${ch}'`)) bad(`危险通道 ${ch} 从 handlers 消失（渲染端 todoAPI.purge* 将悬空）`)
  else if (!(idxSrc.match(new RegExp(`'${ch.replace(/:/g, '\\:')}'[^]*?assertMainWindow\\(e\\)`)) )) bad(`危险通道 ${ch} 缺 assertMainWindow(e) 主窗守卫`)}
ok('purge 专用通道存在且带主窗守卫')

if (failed) { console.error(`✗ IPC op 覆盖门禁：${failed} 处失配`); process.exit(1) }
console.log('✓ IPC op 覆盖门禁通过')
