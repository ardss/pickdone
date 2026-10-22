/**
 * Journey driver — boot a REAL, fully isolated app instance and walk it like a user would.
 *
 * Built for the 2026-10-22 real-user journey audit (goal: "每层都对、拼起来不成立" 的断裂只能在
 * 真实电路上暴露). Reuses every lesson from tests/e2e-exit-close.test.mjs:
 *   - ELECTRON_RUN_AS_NODE strip (agent/IDE hosts export it; electron.exe boots as plain Node)
 *   - interactive readiness (a page target existing is NOT enough: first app:// load can
 *     fail-and-retry — ready = the renderer ANSWERS a probe; refetch targets every round)
 *   - boot-failure orphan hygiene (a spawn that fails its wait is killed, never port-squatting)
 *   - per-boot fresh TODO_USER_DATA_DIR/TODO_DB_DIR (singleton lock is per data dir)
 *
 * Usage A (scripted journeys — preferred):
 *   import { bootJourney } from '../../scripts/journey-driver.mjs'
 *   const j = await bootJourney({ cdpPort: 9381, seedConfig: { closeActionMinimize: false } })
 *   await j.fill('#quick-add-input', 'buy milk'); await j.click('.btn-add')
 *   await j.shot('01-after-add.png')          // PNG on disk — READ IT, review like a user
 *   const count = await j.eval('document.querySelectorAll(".todo-item").length')
 *   await j.end()                              // kills the instance, removes the data dir
 *
 * Usage B (CLI poke): node scripts/journey-driver.mjs shot 9381 out.png
 *
 * Team rules (AGENTS.md): ONE cdpPort per engineer; renderer-dist is PRE-BUILT by the lead —
 * NEVER run build:renderer concurrently; end() every journey (orphan electrons hold ports).
 *
 * Round-2 additions (2026-10-22 deep audit):
 *   bootJourney({ resumeDir })  → re-boot on an EXISTING data dir (reboot-persistence journeys:
 *                                 write → crash() → bootJourney({ resumeDir }) → assert survival)
 *   bootJourney({ dbDir })      → override TODO_DB_DIR independently (dual-instance / CLI-race
 *                                 orchestration: two boots sharing one db dir, different userData)
 *   j.crash()                   → hard-kill WITHOUT the quit chain (crash-recovery journeys)
 *   j.end({ preserveDir })      → keep the data dir across a reboot pair; rm it on the final end
 *   CLI seeding pattern (pre-boot, app closed) — MIND THE ENV SPLIT (live-verified by pomodoro R2):
 *     the APP derives its db from TODO_USER_DATA_DIR (<userData>/todos.db, src/main/index.js),
 *     while the CLI prefers TODO_DB_DIR as the dir CONTAINING todos.db (user-dir.js).
 *     Point the CLI at the USERDATA ROOT, not at j.dbDir:
 *     $env:TODO_DB_DIR='<j.dataDir>'; node cli/… add "…"   (AGENTS isolation rule satisfied)
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const requireElectron = () => { try { const p = require('electron'); return p } catch { return null } }

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson (url, timeoutMs = 1500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

/** Minimal CDP client over one WebSocket. */
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
    if (!data) throw new Error('captureScreenshot returned no data: ' + JSON.stringify(r).slice(0, 200))
    writeFileSync(outFile, Buffer.from(data, 'base64'))
    return outFile
  }
  close () { try { this.ws.close() } catch { /* already gone */ } }
}

/** Interactive readiness: refetch targets each round; ready when the renderer ANSWERS. */
async function waitInteractiveMain (cdpBase, { requireApi = true, timeoutMs = 45000, urlFilter } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let page = null
    try {
      const list = await fetchJson(cdpBase + '/json')
      page = list.find(t => t.type === 'page' && t.url.includes('index.html') && (urlFilter ? urlFilter(t.url) : !t.url.includes('__tomato-float')))
    } catch { /* booting */ }
    if (page) {
      let cdp = null
      try {
        cdp = await Cdp.connect(page.webSocketDebuggerUrl)
        const probe = await cdp.eval('JSON.stringify({ api: !!(window.todoAPI && window.todoAPI.closeRequest), iso: !!(window.todoAPI && window.todoAPI.isDataIsolated) })', 3000)
        const parsed = JSON.parse(probe)
        if ((parsed.api || !requireApi) && parsed.iso) return { wsUrl: page.webSocketDebuggerUrl, cdp }
      } catch { /* reload window: refetch next round */ }
      if (cdp) cdp.close()
    }
    await sleep(500)
  }
  throw new Error('interactive renderer not ready within ' + timeoutMs + 'ms')
}

/**
 * Boot one isolated real instance. seedConfig: object merged into a pre-seeded config.json
 * (e.g. { closeActionMinimize: false, skipOnboarding: ... } — keys must match config-store).
 */
export async function bootJourney ({ cdpPort, seedConfig, urlFilter, dataDir: resumeDir, dbDir: dbDirOverride } = {}) {
  if (!cdpPort) throw new Error('bootJourney: cdpPort is required (one per engineer, e.g. 9381)')
  const electronBin = requireElectron()
  if (!electronBin || !spawnSync) throw new Error('electron binary unavailable')
  const dataDir = resumeDir || (await mkdtemp(join(tmpdir(), 'pickdone-journey-')))
  if (!resumeDir) await mkdir(join(dataDir, 'db'), { recursive: true })
  const dbDir = dbDirOverride || join(dataDir, 'db')
  if (seedConfig) await writeFile(join(dataDir, 'config.json'), JSON.stringify(seedConfig), 'utf8')
  const env = {
    ...process.env,
    TODO_USER_DATA_DIR: dataDir,
    TODO_DB_DIR: dbDir,
  }
  delete env.ELECTRON_RUN_AS_NODE // DSH/IDE hosts export it → electron boots as plain Node and crashes
  const child = spawn(electronBin, ['.', '--no-focus', '--remote-debugging-port=' + cdpPort], { cwd: appRoot, env, stdio: 'ignore' })
  const cdpBase = 'http://127.0.0.1:' + cdpPort
  const kill = () => { try { if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ } }
  try {
    const { wsUrl, cdp } = await waitInteractiveMain(cdpBase, { urlFilter })
    return {
      dataDir, dbDir, child, cdpBase,
      /** Evaluate in the MAIN shell page. */
      eval: (expr, timeoutMs) => cdp.eval(expr, timeoutMs),
      /** Poll an expression until truthy — SPA mount/race guard (todoAPI exists before Vue mounts). */
      waitFor: async (expression, { timeoutMs = 15000, intervalMs = 400 } = {}) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          try { const v = await cdp.eval(expression, Math.min(intervalMs * 2, 4000)); if (v) return v } catch { /* retry until deadline */ }
          await sleep(intervalMs)
        }
        throw new Error('waitFor timeout: ' + String(expression).slice(0, 80))
      },
      /** Screenshot the main shell page to a PNG (READ the file afterwards — review like a user). */
      shot: async outFile => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        if (r.error) throw new Error('captureScreenshot failed: ' + JSON.stringify(r.error))
        const data = r.result?.data
        if (!data) throw new Error('captureScreenshot returned no data')
        await writeFile(outFile, Buffer.from(data, 'base64'))
        return outFile
      },
      /** Click by selector (fires a real .click(); Vue handlers respond). */
      click: sel => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element: ${'${'}sel}'); el.click(); return true })()`),
      /** Fill by selector the Vue-compatible way (native setter + input event). */
      fill: (sel, text) => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element: ${'${'}sel}'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`),
      /** List page targets (float/quick-add windows have their own pages). */
      targets: async () => (await fetchJson(cdpBase + '/json')).map(t => ({ type: t.type, url: t.url, ws: t.webSocketDebuggerUrl })),
      /** Connect to a SECONDARY page (float etc.) by url substring. */
      connectPage: async urlPart => {
        const list = await fetchJson(cdpBase + '/json')
        const t = list.find(x => x.type === 'page' && x.url.includes(urlPart))
        if (!t) throw new Error('no page target matching: ' + urlPart)
        return Cdp.connect(t.webSocketDebuggerUrl)
      },
      /** Hard-kill WITHOUT the quit chain (crash-recovery journeys). */
      crash: kill,
      /** Kill the instance; preserveDir=true keeps the data dir for a resumeDir reboot. ALWAYS end. */
      end: async ({ preserveDir = false } = {}) => {
        kill()
        await new Promise(res => { const t = setTimeout(res, 8000); child.once('exit', () => { clearTimeout(t); res() }) })
        if (!preserveDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (err) {
    kill()
    if (!resumeDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/* ---- CLI poke mode: node scripts/journey-driver.mjs <eval|shot|targets> <cdpPort> [arg] ---- */
const argv = process.argv.slice(2)
if (argv[0] === 'eval' || argv[0] === 'shot' || argv[0] === 'targets') {
  const cdpBase = 'http://127.0.0.1:' + argv[1]
  const { wsUrl, cdp } = await waitInteractiveMain(cdpBase)
  cdp.close()
  const c = await Cdp.connect(wsUrl)
  if (argv[0] === 'eval') console.log(await c.eval(argv[2] || 'document.title'))
  else if (argv[0] === 'shot') console.log('saved:', await c.shot(argv[2] || 'journey-shot.png'))
  else {
    const list = await fetchJson(cdpBase + '/json')
    console.log(list.map(t => t.type + ' ' + t.url).join('\n'))
  }
  c.close()
  process.exit(0)
}
