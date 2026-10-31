// W23 打包版粘贴链路端到端实验 v2 — 用仓库自带 lib-cdp-client
const { spawn } = require('child_process')
const fs = require('fs'), os = require('os'), path = require('path')
const { cdpConnect, getJSON } = require('../cli/lib-cdp-client.cjs')

const TMP = path.join(os.tmpdir(), 'w23-paste-exp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
void spawn('F:\\PickDone\\PickDone.exe', ['--remote-debugging-port=9333'], {
  env: { ...process.env, TODO_USER_DATA_DIR: TMP }, stdio: 'ignore',
})
const wait = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  let wsUrl = null
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJSON('http://127.0.0.1:9333/json/list')
      const page = list.find(t => t.type === 'page') 
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch (e) { /* booting */ }
    await wait(1000)
  }
  if (!wsUrl) throw new Error('CDP not reachable')
  const cdp = await cdpConnect(wsUrl)
  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result ? r.result.value : JSON.stringify(r).slice(0, 200)
  }
  await wait(15000)
  console.log('title:', await evalJs('document.title'))
  console.log('has uploadAttachment:', await evalJs('!!(window.todoAPI && window.todoAPI.uploadAttachment)'))
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const up = await evalJs(`window.todoAPI.uploadAttachment({ taskId: 'tid_exptest', name: 'exp.png', dataBase64: ${JSON.stringify(b64)}, type: 'image/png' }).then(r => JSON.stringify(r)).catch(e => 'UPLOAD-ERR: ' + (e && e.message))`)
  console.log('upload:', up)
  let url = null
  try { url = JSON.parse(up).url } catch (e) {}
  console.log('url:', url)
  if (url) {
    console.log('render:', await evalJs(`new Promise(res => { const i = new Image(); i.onload = () => res('RENDER-OK ' + i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('RENDER-ERR src=' + i.src.slice(0, 80)); i.src = ${JSON.stringify(url)}; setTimeout(() => res('RENDER-TIMEOUT'), 5000) })`))
  }
  try { console.log('files dir:', fs.readdirSync(path.join(TMP, 'files'))) } catch (e) { console.log('files dir: (none)', e.code) }
  process.exit(0)
})().catch(e => { console.error('EXP-FAIL:', e.message); process.exit(1) })
