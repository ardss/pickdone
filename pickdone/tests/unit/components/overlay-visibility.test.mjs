/**
 * 遮罩可见性门禁(2026-09-02 事故沉淀)——「遮罩挡住全屏、弹窗盒子却不可见」的整页点不动类 bug,
 * 常规功能断言查不出来(功能在遮罩下面是对的),因此单独立门:
 *  1. 最小支持视口(760x480,=主窗 minWidth 750+余量,2026-09-03 从 720 上调:渐进折叠后最小窗仍须可用)下逐主视图采样:elementFromPoint 必须落在应用内容内,或落在
 *     「可见且有内容」的弹层内;落在裸遮罩/空壳上 = 隐形遮挡,红。
 *  2. 强制弹出 $confirm(与昨日剩余弹窗同款调用),断言盒体完整落在视口内且按钮可被命中
 *     (昨日剩余事故的直接回归锁:窄窗下盒体曾溢出视口=整页点不动)。
 * 自拉起隔离实例(TODO_USER_DATA_DIR),~25s,纳入 run-all 自动发现。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnApp, stopApp, connectCdp, evalJson, send, sleep } from '../../lib/runtime.mjs'

let ctx

test('setup: spawn isolated instance at minimum supported viewport', async () => {
  ctx = await spawnApp({ name: 'overlay-gate' })
  await connectCdp(ctx)
  await send(ctx, 'Emulation.setDeviceMetricsOverride', { width: 760, height: 480, deviceScaleFactor: 1, mobile: false })
  // 隔离实例=全新首次启动,新手引导浮层(ob-opts)会压在任何弹窗之上——先记账"已看过"并清掉现场,
  // 本门测的是确认框可见性;引导与弹层的先后关系是既有独立约束(引导须等弹层退场)
  await evalJson(ctx, `(() => {
    localStorage.setItem('onboardingToursSeen', JSON.stringify({ today: true, editpanel: true, pips: true })) localStorage.setItem('appLocale', 'en-US')
    localStorage.setItem('onboardingDone', '1')
    document.querySelectorAll('[class*="driver-js"], [class*="driver-popover"], .ob-opts').forEach(e => e.remove())
    return 'tours dismissed'
  })()`)
  await evalJson(ctx, "location.reload(); 'reloading'")
  await sleep(2500)
  await evalJson(ctx, "'boot-ok'")
})

/** 隐形遮挡采样:3x3 网格取 elementFromPoint,顶元素须在 #app 内,或在有可见文字的弹层内 */
async function scanView (hash) {
  if (!ctx || typeof ctx._send !== 'function') throw new Error('ctx._send lost: ' + (ctx ? Object.keys(ctx).join(',') : 'no ctx'))
  await evalJson(ctx, `location.hash = '${hash}'; 'ok'`)
  await sleep(900)
  const r = await evalJson(ctx, `(() => {
    const pts = []
    for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75]) pts.push([innerWidth * fx, innerHeight * fy])
    const blockers = []
    for (const [x, y] of pts) {
      let el = document.elementFromPoint(x, y)
      if (!el) { blockers.push({ x, y, reason: 'no element' }); continue }
      if (el.closest('#app')) continue
      // 应用内容之外 = 某种弹层。可见且有文字的弹层(确认框/对话框)是合法遮挡,裸遮罩/空壳是事故
      const layer = el.closest('.el-message-box, .el-dialog, .modal')
      const visibleText = layer ? (layer.innerText || '').trim() : ''
      if (!layer || !visibleText) blockers.push({ x, y, reason: 'bare overlay', top: el.className && String(el.className).slice(0, 40) })
    }
    return { hash: location.hash, blockers }
  })()`)
  assert.equal(r.blockers.length, 0, `隐形遮挡 @ ${r.hash}: ` + JSON.stringify(r.blockers))
}

test('no invisible blocker on main views (760x480)', async () => {
  for (const hash of ['#/todo-list/today', '#/todo-list/todo-box', '#/todo-list/completed', '#/todo-list/statistics']) {
    await scanView(hash)
  }
})

test('$confirm box fully inside viewport and buttons hit-testable (regression: leftover-ask dialog)', async () => {
  const r = await evalJson(ctx, `(async () => {
    const vm = window.appUI
    if (!vm || !vm.$confirm) return { err: 'no appUI' }
    const p = vm.$confirm('门禁测试可见性', 'gate', { confirmButtonText: 'A', cancelButtonText: 'B', type: 'info' })
    await new Promise(res => setTimeout(res, 500))
    const box = document.querySelector('.el-message-box')
    if (!box) return { err: 'no box' }
    const rect = box.getBoundingClientRect()
    const btn = [...box.querySelectorAll('button')].find(b => b.textContent.trim() === 'A')
    const br = btn ? btn.getBoundingClientRect() : null
    const dbg = {}
    const hit = br ? (() => { const e = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2); if (!e) return false; if (btn.contains(e)) return true; dbg.hitEl = e.tagName + '.' + String(e.className).slice(0, 40); return false })() : false
    const geo = { inTop: rect.top >= 0, inLeft: rect.left >= 0, inRight: rect.right <= innerWidth, inBottom: rect.bottom <= innerHeight, w: rect.width, h: rect.height }
    try { [...document.querySelectorAll('.el-message-box__btns button')].find(b => b.textContent.trim() === 'B')?.click() } catch {}
    try { await p } catch {}
    return { geo, hit, dbg, bg: getComputedStyle(box).backgroundColor }
  })()`)
  assert.ok(!r.err, 'confirm open failed: ' + r.err)
  assert.ok(r.geo.inTop && r.geo.inLeft && r.geo.inRight && r.geo.inBottom, 'confirm box overflows viewport: ' + JSON.stringify(r.geo))
  assert.ok(r.hit, 'confirm confirm-button not hit-testable (blocked by: ' + (r.dbg.hitEl || 'offscreen') + ')')
  assert.notEqual(r.bg, 'rgba(0, 0, 0, 0)', 'confirm box background is transparent (invisible)')
})

after(async () => { await stopApp(ctx) })
