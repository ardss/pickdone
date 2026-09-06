// 官网在线演示打包:renderer 源码 --config vite.config.demo.mjs 静态构建 →
// docs/宣传/website/demo/,再做协议改写(app://app → 相对路径)+ 资产随行 +
// 注入浏览器 shim(数据仅存 localStorage)与演示数据种子、演示角标。
// 产物即官网 /demo/ 子路径,部署时与 website/index.html 同源发布即可。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const demoDir = path.resolve(appRoot, '../../pickdone-site/demo')
const assetsSrc = path.join(appRoot, 'assets')
const TEXT_EXT = new Set(['.css', '.js', '.mjs', '.html', '.json', '.svg'])

const walk = (dir, acc = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
// fs.cpSync 在含中文的目标路径上会静默不复制(Node 22/Win 实测),手写递归复制
const copyTree = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    // 白名单式过滤:备份/临时物(media.bak 等)若混进 assets 会被原样发布到公开官网——宁可漏带也不误发
    if (name.startsWith('.') || /\.bak($|\.)|\.tmp$|~$/i.test(name)) continue
    const s = path.join(src, name)
    const d = path.join(dst, name)
    if (fs.statSync(s).isDirectory()) copyTree(s, d)
    else fs.copyFileSync(s, d)
  }
}
const rewriteText = (text, isCss) => isCss
  ? text.split('app://app/assets/').join('../')
  : text.split('app://app/').join('./')

// ---------- 1) vite 构建 ----------
console.log('[demo] vite build (renderer → website/demo) ...')
const r = spawnSync(process.execPath,
  [path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(appRoot, 'vite.config.demo.mjs')],
  { cwd: appRoot, stdio: 'inherit' })
if (r.status !== 0) { console.error('[demo] vite build failed'); process.exit(r.status ?? 1) }

// ---------- 2) 资产随行:pickdone/assets → demo/assets(emptyOutDir 已清场,直接铺入) ----------
const assetsDst = path.join(demoDir, 'assets')
copyTree(assetsSrc, assetsDst)

// ---------- 3) 产物协议改写:html/js 里的 app://app/ → ./;assets 内 css 的 url → ../ ----------
// 另:runtime-app-assets 虚拟模块产出 "/assets/..." 根绝对串(app:// 协议运行时 URL),
// web 子路径下需改写为 ./assets/...,注意勿误伤协议相对的 "//assets"
for (const f of walk(demoDir)) {
  if (!TEXT_EXT.has(path.extname(f))) continue
  let text = fs.readFileSync(f, 'utf8')
  const isCss = path.extname(f) === '.css'
  let next = rewriteText(text, isCss)
  if (!isCss) next = next
    .split('"/assets/').join('"./assets/')
    .split("'/assets/").join("'./assets/")
    .split('`/assets/').join('`./assets/')
    // --ico 自定义属性里的 url() 消费外部图标资产,
    // 按样式表目录(assets/css/)解析而非文档,故须退两级
    .split('"--ico":"url(\'./assets/').join('"--ico":"url(\'../../assets/')
  if (next !== text) fs.writeFileSync(f, next)
}

// ---------- 4) Sortable(源 index.html 引 app://app/node_modules/sortablejs/...) ----------
fs.mkdirSync(path.join(demoDir, 'node_modules', 'sortablejs'), { recursive: true })
fs.copyFileSync(path.join(appRoot, 'node_modules', 'sortablejs', 'Sortable.min.js'),
  path.join(demoDir, 'node_modules', 'sortablejs', 'Sortable.min.js'))

// ---------- 5) 浏览器 shim(与 5175 调试宿主同一份) ----------
fs.copyFileSync(path.join(appRoot, 'browser-dev', 'todo-browser-shim.js'),
  path.join(demoDir, 'demo-shim.js'))

// ---------- 6) 注入 shim + 演示数据种子 + 演示角标 ----------
const htmlPath = path.join(demoDir, 'index.html')
let html = fs.readFileSync(htmlPath, 'utf8')
html = html.replace('<title>拾事</title>', '<title>拾事 PickDone — 在线演示(虚拟数据)</title>')
if (!html.includes('PICKDONE-DEMO-INJECT')) {
  const inject = `
<!-- PICKDONE-DEMO-INJECT:浏览器 shim(数据仅存 localStorage)+ 演示数据 + 角标 -->
<style>
#demo-badge{position:fixed;left:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:10px;
  background:#0c0e14ee;border:1px solid #2c3350;border-radius:999px;padding:9px 16px 9px 13px;
  font:12.5px/1.4 "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;color:#b9c0d8;
  box-shadow:0 12px 40px #0009;backdrop-filter:blur(8px)}
#demo-badge i{width:8px;height:8px;border-radius:50%;background:#0f9d8f;flex-shrink:0;
  box-shadow:0 0 0 0 #0f9d8f66;animation:demoPulse 2.2s infinite}
@keyframes demoPulse{0%{box-shadow:0 0 0 0 #0f9d8f66}70%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
#demo-badge b{color:#eceef5;font-weight:600}
#demo-badge a{color:#35c2ae;text-decoration:none;margin-left:2px;white-space:nowrap}
#demo-badge a:hover{text-decoration:underline}
@media(max-width:640px){#demo-badge span.opt{display:none}}
</style>
<script>
// 种子先行(必须在 demo-shim.js 之前):
// ①浅色(官网暖纸白;设置 LS+DB meta 双轨新者胜,两头同写盖时间戳防旧镜像反扑)
// ②语言跟随官网 pd-lang → 应用 appLocale
// ③语言相对上次种子发生变更时清掉 shim 数据,让 shim/app 以新语言重灌种子
;(function(){
  try {
    var s = {}
    try { s = JSON.parse(localStorage.getItem('settingsState') || '{}') || {} } catch (e) {}
    if (s.colorMode !== 'light') {
      s.colorMode = 'light'
      localStorage.setItem('settingsState', JSON.stringify(s))
      localStorage.setItem('settingsMirrorAt', String(Date.now()))
    }
    var loc = 'zh-CN'
    try {
      var pl = window.parent && window.parent.localStorage && window.parent.localStorage.getItem('pd-lang')
      if (pl === 'en' || pl === 'zh') loc = pl === 'en' ? 'en-US' : 'zh-CN'
      localStorage.setItem('appLocale', loc)
    } catch (e) { /* 跨源时沿用已存值 */ }
    try { loc = localStorage.getItem('appLocale') || loc } catch (e) {}
    var prev = null
    try { prev = localStorage.getItem('demoSeedLoc') } catch (e) {}
    if (prev !== loc) {
      try {
        localStorage.removeItem('appBrowserShim.todos.v4')
        localStorage.removeItem('appBrowserShim.meta')
        localStorage.removeItem('appShimCategories')
        localStorage.removeItem('eveShimCategories')
      } catch (e) {}
    }
    try { localStorage.setItem('demoSeedLoc', loc) } catch (e) {}
  } catch (e) { /* 忽略 */ }
})()
</script>
<script>
// iframe 内应用的 .focus()(QuickAdd 启动聚焦等)会让 Chromium 把父页面滚到 iframe 处,
// 这是"打开官网自动滚到演示区"的根因;demo 内所有 focus 一律 preventScroll
;(function(){
  var of = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function () {
    var a = Array.prototype.slice.call(arguments)
    var opt = (a[0] && typeof a[0] === 'object') ? a[0] : {}
    opt.preventScroll = true
    a[0] = opt
    return of.apply(this, a)
  }
})()
</script>
<script src="./demo-shim.js?v=${Date.now()}"></script>
<script>
// 演示专注记录:与 browser-dev 调试宿主同款注入(tomatoAppendMany 原子 op,幂等不双账),标签双语
;(function () {
  var poll = function () {
    if (!window.todoAPI || !window.todoAPI.dbCall) { setTimeout(poll, 300); return }
    window.todoAPI.dbCall('tomatoAll').then(function (existing) {
      if ((existing || []).some(function (r) { return String(r.tomatoId || '').indexOf('tmt_demo_') === 0 })) return
      var en = false
      try { en = localStorage.getItem('appLocale') === 'en-US' } catch (e) {}
      var L = en ? {
        morning: 'Morning sync', spec: 'Spec review', ui: 'UI fidelity review', weekly: 'Weekly report',
        words: 'Memorize words', vue: 'Reading: Deep into Vue.js', plan: 'Sprint planning',
        api: 'API integration', daily: 'Daily report'
      } : {
        morning: '晨会跟进', spec: '需求梳理', ui: '评审 UI 还原度问题清单', weekly: '写周报',
        words: '背 30 个单词', vue: '阅读《深入浅出 Vue.js》', plan: '迭代排期',
        api: '接口联调', daily: '日报'
      }
      var mk = function (demoId, baseDay, sh, sm, durMin, focus) {
        var start = new Date(baseDay); start.setHours(sh, sm, 0, 0)
        var end = new Date(start.getTime() + durMin * 60000)
        var p2 = function (n) { return (n < 10 ? '0' : '') + n }
        var dk = baseDay.getFullYear() + '-' + p2(baseDay.getMonth() + 1) + '-' + p2(baseDay.getDate())
        return { tomatoId: 'tmt_demo_' + demoId, endTime: end.getTime(),
          focusDuration: durMin, restDuration: 0, succeed: true, status: 'local', focus: focus, focusTaskId: null, dateKey: dk }
      }
      var today = new Date(); today.setHours(0, 0, 0, 0)
      var yest = new Date(today.getTime() - 86400000)
      var recs = [
        mk('d1', today, 9, 0, 25, L.morning), mk('d2', today, 9, 30, 25, L.morning),
        mk('d3', today, 10, 0, 25, L.spec), mk('d4', today, 10, 30, 25, L.spec), mk('d5', today, 11, 0, 25, L.spec),
        mk('d6', today, 14, 0, 25, L.ui), mk('d7', today, 15, 0, 25, L.weekly),
        mk('d8', today, 16, 30, 25, L.words),
        mk('d9', today, 20, 0, 25, L.vue), mk('d10', today, 20, 30, 25, L.vue),
        mk('e1', yest, 9, 0, 25, L.plan), mk('e2', yest, 9, 35, 25, L.plan),
        mk('e3', yest, 14, 0, 25, L.api), mk('e4', yest, 14, 40, 25, L.api), mk('e5', yest, 16, 0, 25, L.daily)
      ]
      window.todoAPI.dbCall('tomatoAppendMany', recs).catch(function (e) { console.warn('[demo] 注入失败', e) })
    }).catch(function () { setTimeout(poll, 500) })
  }
  setTimeout(poll, 800)
})()
</script>
<script>
// 演示角标:仅独立打开 demo/ 时挂载;被官网 iframe 内嵌时不注入,避免悬层遮挡应用界面
;(function(){
  if (window.self !== window.parent) return
  var t = setInterval(function(){
    if (!document.body) return
    clearInterval(t)
    var el = document.createElement('div')
    el.id = 'demo-badge'
    el.innerHTML = '<i></i><span><b>在线演示</b> · 虚拟数据仅存于你的浏览器' +
      '<span class="opt"> · 完整体验请</span></span><a href="../" class="opt">下载完整版 →</a>'
    document.body.appendChild(el)
  }, 200)
})()
</script>`
  html = html.replace('<script type="module"', inject + '\n  <script type="module"')
  fs.writeFileSync(htmlPath, html)
}

const du = walk(demoDir).reduce((n, f) => n + fs.statSync(f).size, 0)
console.log('[demo] 完成 → pickdone-site/demo (' + (du / 1048576).toFixed(1) + ' MB,含资产随行)')
