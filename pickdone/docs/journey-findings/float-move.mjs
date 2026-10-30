/* one-shot float window move via CDP Browser domain (raw error output) */
const port = process.argv[2] || '9382'
const left = Number(process.argv[3] || 120)
const top = Number(process.argv[4] || 120)
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find(x => x.type === 'page' && x.url.includes('__tomato-float'))
if (!t) { console.log('NO-FLOAT-TARGET'); process.exit(1) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const send = (method, params) => new Promise(res => {
  const i = ++id
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === i) res(m) }
  ws.send(JSON.stringify({ id: i, method, params }))
})
const w = await send('Browser.getWindowForTarget', { targetId: t.id })
console.log('getWindowForTarget:', JSON.stringify(w.result || w.error))
if (w.result && w.result.windowId != null) {
  const s = await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { left, top } })
  console.log('setWindowBounds:', JSON.stringify(s.result || s.error))
  const g = await send('Browser.getWindowBounds', { windowId: w.result.windowId })
  console.log('getWindowBounds:', JSON.stringify(g.result || g.error))
}
const p = await send('Runtime.evaluate', { expression: 'JSON.stringify({x:window.screenX,y:window.screenY})', returnByValue: true })
console.log('renderer-pos:', p.result.result.value)
ws.close()
process.exit(0)
