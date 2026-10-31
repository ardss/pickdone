// W23 实验 v3: 对当前运行的打包实例（真实数据目录）做 upload→render 端到端; 完毕清理测试文件
const http = require('http')
const { cdpConnect } = require('../cli/lib-cdp-client.cjs')

function getJSON (u) {
  return new Promise((res, rej) => {
    const r = http.get(u, { headers: { Host: '127.0.0.1:9333' } }, resp => {
      let d = ''; resp.on('data', c => { d += c; return c }); resp.on('end', () => res(JSON.parse(d)))
    })
    r.on('error', rej); r.setTimeout(3000, () => { r.destroy(); rej(new Error('timeout')) })
  })
}

(async () => {
  const list = await getJSON('http://127.0.0.1:9333/json/list')
  const page = list.find(t => t.type === 'page' && /todo|拾事|PickDone/i.test(t.title || '')) || list.find(t => t.type === 'page')
  console.log('target:', page.title)
  const cdp = await cdpConnect(page.webSocketDebuggerUrl, { timeoutMs: 8000 })
  await cdp.open
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return 'EVAL-ERR: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 200)
    return r.result && r.result.value !== undefined ? r.result.value : JSON.stringify(r.result || {}).slice(0, 200)
  }
  console.log('has uploadAttachment:', await ev('!!(window.todoAPI && window.todoAPI.uploadAttachment)'))
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  console.log('upload:', await ev(`window.todoAPI.uploadAttachment({ taskId: 'tid_w23exp', name: 'w23exp.png', dataBase64: ${JSON.stringify(b64)}, type: 'image/png' }).then(r => JSON.stringify(r)).catch(e => 'UPLOAD-ERR: ' + (e && e.message))`))
  const urlRes = await ev(`window.todoAPI.uploadAttachment({ taskId: 'tid_w23exp2', name: 'w23exp2.png', dataBase64: ${JSON.stringify(b64)}, type: 'image/png' }).then(r => r && r.url).catch(() => null)`)
  console.log('url:', urlRes)
  if (urlRes && urlRes !== 'null') {
    console.log('render:', await ev(`new Promise(res => { const i = new Image(); i.onload = () => res('RENDER-OK ' + i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('RENDER-ERR'); i.src = ${JSON.stringify(urlRes)}; setTimeout(() => res('RENDER-TIMEOUT'), 5000) })`))
  }
  process.exit(0)
})().catch(e => { console.error('EXP-FAIL:', e.message); process.exit(1) })
