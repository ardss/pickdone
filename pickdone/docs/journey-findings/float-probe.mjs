/* one-shot float probe: position + content via CDP */
const port = process.argv[2] || '9382'
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find(x => x.type === 'page' && x.url.includes('__tomato-float'))
if (!t) { console.log('NO-FLOAT-TARGET'); process.exit(0) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const r = await new Promise(res => {
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m) }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `JSON.stringify({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, clock: (document.querySelector('.tomato__time')||{}).textContent, phase: (document.querySelector('.tomato__time small')||{}).textContent, title: document.title })`, returnByValue: true } }))
})
console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r))
ws.close()
process.exit(0)
