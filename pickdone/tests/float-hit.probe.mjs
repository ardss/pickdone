/**
 * 浮窗悬停命中/点击穿透活体探针（脚本化，无需人工碰电脑）
 * 用法: node tests/float-hit.probe.mjs <CDP端口>
 * 前置: 隔离实例已带 --remote-debugging-port 启动（本脚本不拉起应用，附着运行中的实例）。
 * 验证链:
 *   1. CDP 找到 #__tomato-float 页并读出窗口 screenX/screenY（CSS/DIP 坐标）
 *   2. user32 SetCursorPos 把真实光标压到卡片中心（SetCursorPos 物理像素 = DIP×scaleFactor,
 *      scaleFactor 从主进程 display 读——这里通过页面 devicePixelRatio×CSS 坐标换算）
 *   3. 轮询读取 WS_EX_TRANSPARENT 位: 光标入卡 → 位必须被主进程轮询清掉(可点);
 *      光标移离 → 位必须重新置上(穿透)
 * 退出码 0=通过 1=失败。注意: 会短暂占用真实光标约 3 秒,适合提交前手动跑一次,不入 check:all。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const port = process.argv[2] || '9444'
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const float = list.find(t => t.type === 'page' && String(t.url).includes('__tomato-float'))
if (!float) { console.error('FAIL: 浮窗页不存在(浮窗未显示?)'); process.exit(1) }

const ws = new WebSocket(float.webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
const evalJs = expr => new Promise((ok) => {
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) ok(m.result?.result?.value) }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
})

const geo = await evalJs(`JSON.stringify({x:window.screenX,y:window.screenY,w:window.outerWidth,h:window.outerHeight,dpr:window.devicePixelRatio,cardTop:document.querySelector('.tomato').getBoundingClientRect().top,cardH:document.querySelector('.tomato').getBoundingClientRect().height})`)
const g = JSON.parse(geo)
console.log('[probe] 浮窗几何', JSON.stringify(g))

// 多实例并行时同位浮窗可能撞匹配(Electron CDP 无 Browser.setWindowBounds 无法挪移唯一化);
// readBit 已带 3 次重试 + 汇总全部匹配取「任一可点」语义,撞窗时 FAIL 先重跑

// 光标移动: PowerShell 与浮窗 JS 同处 DPI 虚拟化坐标系(物理=CSS×scale),SetCursorPos 直接用 CSS 坐标即可命中
const cardCx = Math.round(g.x + g.w / 2)
const cardCy = Math.round(g.y + g.cardTop + g.cardH / 2)
const awayX = Math.round(g.x + g.w / 2)
const awayY = Math.round(g.y - 30) // 窗口上缘之外(内容贴合后窗口没有空区,探"离开窗口"态)

const ps = (script) => exec('powershell', ['-NoProfile', '-Command', script])
const move = (x, y) => ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int a,int b);}' | Out-Null; [M]::SetCursorPos(${x},${y})`).catch(e => { throw new Error('SetCursorPos失败: ' + e.stderr) })

// 读 WS_EX_TRANSPARENT(0x20): 枚举顶层窗按位置/尺寸匹配(PowerShell 非 DPI 感知进程,矩形与 JS CSS 坐标同空间,勿乘 scale;
// screenX/Y 与 GetWindowRect 有 1-2px 取整差——容差 10px;偶发单次枚举抓空,重试 3 次)
const readBit = async () => {
  const l0 = Math.round(g.x), t0 = Math.round(g.y), w0 = Math.round(g.w), h0 = Math.round(g.h)
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class E {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  public struct R { public int l, t, r, b; }
}
'@
$script:hit = ''
$cb = { param($hh, $ll)
  $r = New-Object 'E+R'
  [E]::GetWindowRect($hh, [ref]$r) | Out-Null
  if ([Math]::Abs($r.l - (${l0})) -le 5 -and [Math]::Abs($r.t - (${t0})) -le 5 -and [Math]::Abs(($r.r - $r.l) - ${w0}) -le 5 -and [Math]::Abs(($r.b - $r.t) - ${h0}) -le 5) {
    $ex = [E]::GetWindowLongW($hh, -20)
    $script:hit = ([bool]($ex -band 0x20)).ToString()
  }
  return $true }
[E]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:hit`
  for (let i = 0; i < 3; i++) {
    const { stdout } = await ps(script)
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    if (line !== undefined && line !== '') return line.trim() === 'True'
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error('没找到浮窗句柄(重试3次)')
}

await move(cardCx, cardCy)
await new Promise(r => setTimeout(r, 700))
const overCard = await readBit()
await move(awayX, awayY)
await new Promise(r => setTimeout(r, 700))
const overEmpty = await readBit()

console.log(`[probe] 光标在卡片上: WS_EX_TRANSPARENT=${overCard} (期望 false=可点)`)
console.log(`[probe] 光标在空区域: WS_EX_TRANSPARENT=${overEmpty} (期望 true=穿透)`)
if (overCard === false && overEmpty === true) { console.log('PASS'); process.exit(0) }
console.error('FAIL')
process.exit(1)
