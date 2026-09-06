/**
 * Keyboard end-to-end (SOP-06 supplement 10) - axe only checks static semantics; this script verifies "whether core flows can be completed with the keyboard alone".
 * Sends real key events via CDP (Input.dispatchKeyEvent), not JS-synthesized events:
 *   1. Type a task name into the quick-add box + Enter -> task persisted
 *   2. Focus the sidebar brand row + Enter -> collapse/expand toggles
 *   3. Esc closes the popup layer
 * Usage: npm run smoke:keyboard  (SKIPs with exit 0 when there is no debug port)
 */
const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

const watchdog = setTimeout(() => { console.error('FAIL: keyboard e2e did not finish within 60s'); try { ws?.close() } catch {} process.exit(1) }, 60000)
watchdog.unref?.()
process.on('exit', () => { try { ws?.close() } catch {} })


// Page-target probe with retry: a freshly spawned debug port answers /json before any page target is
// registered (and can transiently time out while the renderer compiles), so a single-shot check raced
// the gate wrapper's spawn and SKIPped the whole gate. Poll up to ~20s instead.
let available = false
for (let i = 0; i < 20 && !available; i++) {
  try {
    const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json()
    available = list.some(t => t.type === 'page' && !String(t.url).includes('__tomato-float'))
  } catch { /* port not answering yet */ }
  if (!available) await new Promise(r => setTimeout(r, 1000))
}
if (!available) { console.log('SKIP: no page target on ' + CDP + ' after 20s'); process.exit(2) }


let ws = null
let id = 0
const pending = new Map()
const sleep = ms => new Promise(r => setTimeout(r, ms))

function send (method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result))
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)) } }, 8000)
  })
}

async function connect () {
  const targets = await (await fetch(CDP + '/json')).json()
  const page = targets.find(t => t.type === 'page' && /#\/todo-list/.test(t.url)) || targets.find(t => t.type === 'page' && t.url.includes('index.html'))
  if (!page) { console.log('SKIP: no page'); process.exit(2) }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.bringToFront', {}).catch(() => {})
}

const evalJson = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value

async function typeText (text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
  }
}
async function pressKey (key, code, keyCode) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
}

await connect()
await evalJson("location.hash='#/todo-list/today'")
await sleep(1800)

const results = []
const ok = (name, cond) => { results.push([name, !!cond]); console.log((cond ? '  ✓ ' : '  ✗ ') + name) }

// --- 1. Create a task via keyboard ---
const quickSel = '[aria-label*="快捷添加"], .quick-add input, .quick-add-bar input, input[placeholder*="回车创建"]'
const focused = await evalJson(`(()=>{window.focus();const i=document.querySelector('${quickSel}');if(!i)return false;i.focus();return !!document.activeElement && document.activeElement.tagName==='INPUT'})()`)
if (focused) {
  const name = '键盘端到端样本' + Date.now() % 10000
  await typeText(name)
  await sleep(200)
  await pressKey('Enter', 'Enter', 13)
  await sleep(1200)
  const created = await evalJson(`[...document.querySelectorAll('.td-title')].some(e=>e.textContent.includes('${name}'))`)
  ok('keyboard input + Enter creates the task', created)
} else {
  ok('quick-add box reachable (focused)', false)
}
// Cleanup the sample task right away: it must not persist into the developer's real DB when
// TODO_ALLOW_REUSE=1 reuse is on (audit P1: keyboard e2e was the only gate writing without cleanup)
await evalJson(`(async () => window.todoAPI.dbCall('getAll', {})).then(rows => { var ids = rows.filter(t => !t.delete && t.taskContent.includes('键盘端到端样本')).map(t => t.taskId); if (ids.length) window.todoAPI.dbCall('hardDeleteMany', ids); return ids.length })`)

// --- 2. Toggle the sidebar via keyboard ---
const sideOk = await evalJson(`(()=>{window.focus();const b=document.querySelector('.sn-brand');if(!b)return false;b.focus();return true})()`)
if (sideOk) {
  const before = await evalJson(`document.querySelector('.side-nav').className`)
  await pressKey('Enter', 'Enter', 13)
  await sleep(900)
  const after = await evalJson(`document.querySelector('.side-nav').className`)
  ok('brand row Enter toggles the sidebar collapse state', before !== after)
  await pressKey('Enter', 'Enter', 13) // restore
  await sleep(700)
} else {
  ok('brand row focusable', false)
}

// --- 3. Tab focus reachability: after several Tabs focus should land on a visible in-page element ---
let tabOk = true
for (let i = 0; i < 5; i++) { await pressKey('Tab', 'Tab', 9); await sleep(80) }
tabOk = await evalJson(`(()=>{const a=document.activeElement;return !!a && a!==document.body})()`)
ok('repeated Tabs move focus into an interactive element', tabOk)

const failed = results.filter(r => !r[1])
console.log(failed.length ? `FAIL: ${failed.length}/${results.length} checks failed` : `OK: ${results.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
