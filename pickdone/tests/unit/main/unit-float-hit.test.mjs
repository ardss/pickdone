/**
 * 浮窗悬停命中纯函数单测（isInsideHit —— 主进程轮询点击穿透的判定核心）
 * 背景: 150% 缩放下 setIgnoreMouseEvents forward:true 转发整链失效（光标压卡渲染端零 mousemove），
 * 2026-09-02 根修改为主进程轮询光标; 判定逻辑抽出为纯函数在此锁定语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// electron 在单测环境不可用,只加载会 require('electron') 的模块顶层——tomato-float.js 顶层
// require 了 electron(解构 BrowserWindow/screen)。为测纯函数,注入最小 stub。
const Electron = require.resolve('electron', { paths: [process.cwd()] })
require.cache[Electron] = { id: Electron, filename: Electron, loaded: true, exports: { BrowserWindow: {}, screen: {}, app: {} } }
const { isInsideHit, clampDrag } = require('../../../src/main/tomato-float.js')

// 窗口 240×320 @ (100,200); 卡片=底部 86
const B = { x: 100, y: 200, width: 240, height: 320 }

test('float isInsideHit: 卡片条命中(底部86)', () => {
  assert.equal(isInsideHit({ x: 220, y: 200 + 320 - 1 }, B, false, 86), true, '卡底缘上1px命中')
  assert.equal(isInsideHit({ x: 220, y: 200 + 320 - 86 }, B, false, 86), true, '卡片顶缘命中')
  assert.equal(isInsideHit({ x: 220, y: 200 + 320 - 87 }, B, false, 86), false, '卡片上方1px不命中')
})

test('float isInsideHit: 空区域穿透', () => {
  assert.equal(isInsideHit({ x: 220, y: 210 }, B, false, 86), false, '窗口上部空区穿透')
  assert.equal(isInsideHit({ x: 99, y: 500 }, B, false, 86), false, '窗口左缘外不命中')
  assert.equal(isInsideHit({ x: 341, y: 500 }, B, false, 86), false, '窗口右缘外不命中')
})

test('float isInsideHit: 展开层打开=全窗口命中', () => {
  assert.equal(isInsideHit({ x: 220, y: 210 }, B, true, 86), true, '菜单打开时上部空区也响应')
  assert.equal(isInsideHit({ x: 220, y: 200 + 320 + 1 }, B, true, 86), false, '窗口外仍不命中')
})

// ---- clampDrag(2026-09-05):折叠态夹可见卡片(顶可贴顶/底不没任务栏),展开态夹窗口矩形 ----
const AREA = { x: 0, y: 0, width: 1707, height: 912 } // 主屏 150% DIP workArea
const H = 320, CARD = 86

test('float clampDrag: 折叠态卡片可贴到屏幕顶(无形墙回归)', () => {
  // 窗口 y = -(H-CARD) = -234 时卡片顶恰在 area.y=0,必须放行
  const r = clampDrag(500, -(H - CARD), H, false, AREA)
  assert.equal(r.y, -(H - CARD), '卡片顶=工作区顶,窗口顶悬出屏上234px合法')
  assert.ok(clampDrag(500, -(H - CARD) - 1, H, false, AREA).y >= -(H - CARD), '再往上被夹回贴顶位')
})

test('float clampDrag: 折叠态卡片底不没入工作区底(任务栏下消失回归)', () => {
  // 窗口底 ≤ area.bottom:卡片底=窗口底,不可伸出工作区
  const r = clampDrag(500, AREA.height, H, false, AREA) // 请求窗口顶=area.bottom(整个在屏外下方)
  assert.equal(r.y, AREA.height - H, '窗口底被夹回 area.bottom,卡片保持可见')
})

test('float clampDrag: 展开态夹窗口矩形(顶部不悬出+50px保底)', () => {
  assert.equal(clampDrag(500, -10, H, true, AREA).y, 0, '展开态窗口顶不得悬出屏上')
  assert.equal(clampDrag(500, AREA.height, H, true, AREA).y, AREA.height - 50, '展开态维持50px保底')
})

test('float clampDrag: x 夹紧不变式(左右不出工作区,保100px可见)', () => {
  assert.equal(clampDrag(-50, 100, H, false, AREA).x, 0, '左缘夹回')
  assert.equal(clampDrag(AREA.width, 100, H, false, AREA).x, AREA.width - 100, '右缘保100px可见')
})
