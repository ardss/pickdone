// W23 dev-vs-packaged 对照实验: dev electron 上传→渲染
const { spawn } = require('child_process')
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { cdpConnect } = require('../cli/lib-cdp-client.cjs')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
function getJSON (u) {
  return new Promise((res, rej) => {
    const r = http.get(u, resp => { let d = ''; resp.on('data', c => { d += c; return c }); resp.on('end', () => res(JSON.parse(d))) })
    r.on('error', rej); r.setTimeout(3000, () => { r.destroy(); rej(new Error('timeout')) })
  })
}
const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'w23-paste-dev')
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })
const electron = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
void spawn('cmd.exe', ['/c', electron, '.', '--remote-debugging-port=9335', '--no-focus'], {
  env: { ...process.env, TODO_USER_DATA_DIR: TMP }, cwd: ROOT,
  stdio: ['ignore', fs.openSync(path.join(os.tmpdir(), 'w23-dev-stdout.log'), 'w'), fs.openSync(path.join(os.tmpdir(), 'w23-dev-stderr.log'), 'w')],
})
;(async () => {
  let wsUrl = null
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJSON('http://127.0.0.1:9335/json/list')
      const page = list.find(t => t.type === 'page' && /拾事|todo|pickdone/i.test(t.title || '')) || list.find(t => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch (e) {}
    await wait(1000)
  }
  if (!wsUrl) throw new Error('CDP not reachable')
  const cdp = await cdpConnect(wsUrl, { timeoutMs: 8000 }); await cdp.open
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result && r.result.value !== undefined ? r.result.value : JSON.stringify(r.result || {}).slice(0, 150)
  }
  await wait(12000)
  console.log('dev upload:', await ev(`window.todoAPI.uploadAttachment({ taskId: 'tid_w23dev', name: 'w23dev.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', type: 'image/png' }).then(r => JSON.stringify(r)).catch(e => 'UPLOAD-ERR: ' + (e && e.message))`))
  const url = await ev(`window.todoAPI.uploadAttachment({ taskId: 'tid_w23dev2', name: 'w23dev2.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', type: 'image/png' }).then(r => r && r.url).catch(() => null)`)
  console.log('dev url:', url)
  console.log('dev render:', await ev(`new Promise(res => { const i = new Image(); i.onload = () => res('RENDER-OK ' + i.naturalWidth); i.onerror = () => res('RENDER-ERR'); i.src = ${JSON.stringify(url)}; setTimeout(() => res('RENDER-TIMEOUT'), 5000) })`))
  console.log('dev fetch:', await ev(`Promise.race([fetch(${JSON.stringify(url)}).then(r => 'status=' + r.status), new Promise(r => setTimeout(() => r('FETCH-HANG'), 4000))])`))
  process.exit(0)
})().catch(e => { console.error('DEV-EXP-FAIL:', e.message); process.exit(1) })
