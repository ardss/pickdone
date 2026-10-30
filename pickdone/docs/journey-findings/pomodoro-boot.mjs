/**
 * Pomodoro-auditor boot helper — journey-driver.mjs verbatim minus the hardcoded `--no-focus`.
 *
 * WHY THIS EXISTS: scripts/journey-driver.mjs always passes `--no-focus`, and
 * src/main/handlers/tomato.js gates 'show-tomato-float' on !argv.includes('--no-focus'),
 * so in a bootJourney instance the floater can NEVER appear (小窗 button is a wired no-op).
 * That is a harness artifact, not a product bug — but the float journey (drag, dblclick,
 * float-side give-up) cannot be walked live without a focus-allowed instance. This module
 * replicates the driver's isolation contract (fresh TODO_USER_DATA_DIR/TODO_DB_DIR,
 * ELECTRON_RUN_AS_NODE strip, interactive readiness probe, kill+cleanup on end) with the
 * single flag difference, plus optional persistentDataDir for reboot-persistence checks.
 * scripts/journey-driver.mjs itself is untouched (off-limits per audit rules).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireElectron = () => { try { return require('electron') } catch { return null } }

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson (url, timeoutMs = 1500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
    }
  }
  static async connect (wsUrl) {
    const c = new Cdp(wsUrl)
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('CDP ws error')) })
    return c
  }
  send (method, params = {}, timeoutMs = 10000) {
    const i = ++this.id
    return Promise.race([
      new Promise((res, rej) => {
        this.pending.set(i, res)
        this.ws.send(JSON.stringify({ id: i, method, params }))
      }),
      sleep(timeoutMs).then(() => { this.pending.delete(i); throw new Error('CDP timeout: ' + method) }),
    ])
  }
  async eval (expression, timeoutMs = 10000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (r.result?.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400))
    return r.result?.result?.value
  }
  async shot (outFile) {
    try { await this.send('Page.enable', {}, 5000) } catch { /* already enabled */ }
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 10000)
    if (r.error) throw new Error('captureScreenshot failed: ' + JSON.stringify(r.error))
    const data = r.result?.data
    if (!data) throw new Error('captureScreenshot returned no data')
    writeFileSync(outFile, Buffer.from(data, 'base64'))
    return outFile
  }
  close () { try { this.ws.close() } catch { /* already gone */ } }
}

async function waitInteractiveMain (cdpBase, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let page = null
    try {
      const list = await fetchJson(cdpBase + '/json')
      page = list.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
    } catch { /* booting */ }
    if (page) {
      let cdp = null
      try {
        cdp = await Cdp.connect(page.webSocketDebuggerUrl)
        const probe = await cdp.eval('JSON.stringify({ api: !!(window.todoAPI && window.todoAPI.closeRequest), iso: !!(window.todoAPI && window.todoAPI.isDataIsolated) })', 3000)
        const parsed = JSON.parse(probe)
        if (parsed.api && parsed.iso) return { wsUrl: page.webSocketDebuggerUrl, cdp }
      } catch { /* reload window: refetch next round */ }
      if (cdp) cdp.close()
    }
    await sleep(500)
  }
  throw new Error('interactive renderer not ready within ' + timeoutMs + 'ms')
}

/**
 * Boot one isolated REAL instance WITH focus allowed (no --no-focus).
 * persistentDataDir: keep the same data dir across boots (reboot-persistence journeys);
 * caller must clean it up itself.
 * logFile: capture the electron process's stdout+stderr into this file (round 2: the reminder
 * scheduler asserts via '[Reminder] fired:' stdout lines — bootJourney discards stdio).
 */
export async function bootFocus ({ cdpPort, seedConfig, persistentDataDir, logFile } = {}) {
  if (!cdpPort) throw new Error('bootFocus: cdpPort is required')
  const electronBin = requireElectron()
  if (!electronBin) throw new Error('electron binary unavailable')
  const dataDir = persistentDataDir || await mkdtemp(join(tmpdir(), 'pickdone-pomodoro-'))
  await mkdir(join(dataDir, 'db'), { recursive: true })
  if (seedConfig) await writeFile(join(dataDir, 'config.json'), JSON.stringify(seedConfig), 'utf8')
  const env = { ...process.env, TODO_USER_DATA_DIR: dataDir, TODO_DB_DIR: join(dataDir, 'db') }
  delete env.ELECTRON_RUN_AS_NODE
  let out = null
  if (logFile) { out = await open(logFile, 'a'); out.write('---- boot ' + new Date().toISOString() + ' ----\n') }
  const stdioOpt = out ? ['ignore', out.fd, out.fd] : 'ignore'
  const child = spawn(electronBin, ['.', '--remote-debugging-port=' + cdpPort], { cwd: appRoot, env, stdio: stdioOpt })
  const cdpBase = 'http://127.0.0.1:' + cdpPort
  const kill = () => { try { if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ } }
  try {
    const { wsUrl, cdp } = await waitInteractiveMain(cdpBase)
    return {
      dataDir, child, cdpBase,
      eval: (expr, timeoutMs) => cdp.eval(expr, timeoutMs),
      shot: async outFile => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        if (r.error) throw new Error('captureScreenshot failed: ' + JSON.stringify(r.error))
        const data = r.result?.data
        if (!data) throw new Error('captureScreenshot returned no data')
        await writeFile(outFile, Buffer.from(data, 'base64'))
        return outFile
      },
      click: sel => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element: ${'${'}sel}'); el.click(); return true })()`),
      fill: (sel, text) => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element: ${'${'}sel}'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`),
      targets: async () => (await fetchJson(cdpBase + '/json')).map(t => ({ type: t.type, url: t.url, ws: t.webSocketDebuggerUrl })),
      /** Parity with bootJourney: hard-kill WITHOUT the quit chain. */
      crash: kill,
      connectPage: async urlPart => {
        const list = await fetchJson(cdpBase + '/json')
        const t = list.find(x => x.type === 'page' && x.url.includes(urlPart))
        if (!t) throw new Error('no page target matching: ' + urlPart)
        return Cdp.connect(t.webSocketDebuggerUrl)
      },
      end: async ({ keepDir = false } = {}) => {
        kill()
        await new Promise(res => { const t = setTimeout(res, 8000); child.once('exit', () => { clearTimeout(t); res() }) })
        if (out) { try { await out.close() } catch { /* already closed */ } }
        if (!keepDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (err) {
    kill()
    if (!persistentDataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
