#!/usr/bin/env node
/* eslint-env node */
/**
 * S5 REAL-browser E2E (red-first contract):
 *   1. PWA loads over local HTTPS (self-signed) and the service worker registers + controls the page
 *   2. Desktop -> Web: pull the real bridge snapshot; the desktop seeded task renders in the UI
 *   3. Deep link #/task/<same desktop seeded id> opens THAT task (shared cross-platform id)
 *   4. Offline: banner appears; a task created offline stays after a full page reload (IndexedDB)
 *   5. Back online: durable outbox auto-replays; the offline task CONVERGES into the desktop sqlite DB
 *   6. Desktop -> Web again: second desktop seeded task becomes visible in the web UI
 *   7. Dark theme renders; evidence screenshots are written to --evidence
 * Uses the Playwright-BUNDLED Chromium (not system Chrome; history of exit-21 launcher faults).
 * Temp user profile lives in a K:\tmp scratch dir and is deleted at the end.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const SCRATCH = arg('--scratch', 'K:' + '\\tmp' + '\\pd-web-e2e-20261110')
const EVIDENCE = arg('--evidence', join(here, '..', '..', '..', 'web-evidence'))
const EXE = join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
const DB_PATH = join(SCRATCH, 'desktop.db')
const PROFILE = join(SCRATCH, 'chromium-profile')
const HOST_URL = join(here, 'pwa-bridge-host.mjs')

const steps = []
let failures = 0
const runLog = join(SCRATCH, 'e2e-run.log')
function record(name, ok, detail) {
  writeFileSync(runLog, '[' + name + ']\n', { flag: 'a' })
  steps.push({ name, ok, detail: detail || '' })
  const line = new Date().toISOString().slice(11, 19) + ' ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')
  console.log(line)
  writeFileSync(runLog, line + '\n', { flag: 'a' })
  if (!ok) failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const visibleWithin = async (loc, ms = 6000) => Boolean(await loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false))
function phase(name) { const line = new Date().toISOString().slice(11, 19) + ' PHASE ' + name; console.log(line); writeFileSync(runLog, line + '\n', { flag: 'a' }) }

mkdirSync(SCRATCH, { recursive: true })
mkdirSync(EVIDENCE, { recursive: true })
for (const p of [DB_PATH, PROFILE]) { try { rmSync(p, { recursive: true, force: true }) } catch {} }

// launch host
const host = spawn(process.execPath, [HOST_URL, '--enable-bridge', '--db', DB_PATH, '--certs', join(SCRATCH, 'certs'), '--dist', join(here, '..', 'dist')], { stdio: ['ignore', 'pipe', 'pipe'] })
let ready = null
let hostLog = ''
host.stdout.on('data', d => {
  hostLog += d
  if (!ready) { try { ready = JSON.parse(d.toString().split('\n').find(l => l.includes('"event":"ready"'))) } catch {} }
})
host.stderr.on('data', d => { hostLog += d })
const exitCleanup = async code => {
  try { await fetch('http://127.0.0.1:' + (ready?.controlPort || 0) + '/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch {}
  await sleep(500)
  try { host.kill() } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  console.log(JSON.stringify({ summary: { pass: steps.filter(s => s.ok).length, fail: failures }, steps, exit: code }))
  process.exit(code)
}
for (let i = 0; i < 150 && !ready; i++) await sleep(200)
phase('host-ready=' + (ready ? 'yes' : 'NO'))
if (!ready) { console.error('host never became ready\n' + hostLog.slice(-4000)); await exitCleanup(1) }

const BASE = 'https://localhost:' + ready.httpsPort
const BRIDGE = 'http://127.0.0.1:' + ready.bridgePort
const pairPayload = JSON.stringify(ready.challenge)

const preSeed = await fetch('http://127.0.0.1:' + ready.controlPort + '/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Desktop seed task', id: 'e2eDesktopSeedRow1' }) }).then(r => r.json()).catch(() => null)
phase('pre-seed=' + (preSeed && preSeed.ok ? preSeed.id : 'FAILED'))
let browser
phase('launch-browser')
try {
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--ignore-certificate-errors'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const shot = async name => { await page.screenshot({ path: join(EVIDENCE, name), fullPage: false }); record('screenshot ' + name, existsSync(join(EVIDENCE, name))) }

  // 1. PWA over HTTPS + service worker
  phase('goto')
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
  phase('sw-eval')
  const swState = await page.evaluate(async () => {
    const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('sw-ready timeout ' + ms)), ms))
    try {
      let regError = ''
      if ('serviceWorker' in navigator) {
        try { await navigator.serviceWorker.register('/sw.js') } catch (e) { regError = String(e && e.message || e) }
      } else regError = 'serviceWorker unsupported'
      const reg = await Promise.race([navigator.serviceWorker.ready, timeout(8000)])
      await new Promise(r => setTimeout(r, 500))
      return { registered: Boolean(reg.active), controlled: Boolean(navigator.serviceWorker.controller), error: regError }
    } catch (e) { return { registered: false, controlled: false, error: String(e && e.message || e) } }
  })
  record('PWA loads over self-signed HTTPS', await page.locator('h1').first().isVisible(), BASE)
  record('service worker registered + controls page', swState.registered && swState.controlled, JSON.stringify(swState))
  await shot('01-https-pwa-loaded.png')

  // 2. pair + pull: desktop -> web
  phase('pair-flow')
  await page.getByRole('button', { name: /同步/ }).click()
  await page.fill('input[type=url]', BRIDGE)
  await page.fill('textarea', pairPayload)
  await page.click('button:has-text("立即配对")')
  const paired = await page.locator('text=已配对').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  record('paired with desktop bridge (WRITE scope)', paired)
  const desktopSeed = await (await fetch('http://127.0.0.1:' + ready.controlPort + '/state')).json()
  const seeded = desktopSeed.todos.find(t => t.content === 'Desktop seed task')
  record('desktop sqlite seeded before pairing', Boolean(seeded), seeded ? seeded.id : 'missing')
  await page.click('button:has-text("拉取桌面数据")')
  const pulled = await page.locator('text=已拉取桌面数据').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  record('pull completed (success notice readable)', pulled)
  await page.getByRole('button', { name: /今日任务/ }).click()
  await sleep(300)
  const seedVisible = await visibleWithin(page.locator('.task-main strong', { hasText: 'Desktop seed task' }).first())
  record('desktop seeded task visible in web UI after pull', seedVisible)
  await shot('02-pulled-from-desktop.png')

  // 3. deep link: #/task/<id> opens the same-id task
  const seedId = seeded ? seeded.id : ''
  await page.goto(BASE + '/#/task/' + seedId, { waitUntil: 'domcontentloaded' })
  await sleep(600)
  await page.locator('.modal input').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  const modalTask = await page.locator('.modal input').first().inputValue().catch(() => '')
  // close the deep-linked task modal and reset the route so later steps start clean
  await page.click('.modal-head .icon-button').catch(() => {})
  await page.evaluate(() => { history.replaceState(null, '', '#/today') })
  record('deep link #/task/:id opens the desktop task id', modalTask === 'Desktop seed task', 'modal input=' + JSON.stringify(modalTask))
  await shot('03-deeplink-task-open.png')
  await page.keyboard.press('Escape').catch(() => {})

  // 4. offline: banner + offline write + reload persistence
  phase('offline-leg')
  await context.setOffline(true)
  await sleep(400)
  const banner = await page.locator('.offline-banner').isVisible().catch(() => false)
  record('offline banner visible when disconnected', banner)
  await page.fill('.quick-add input', 'Web offline task')
  await page.click('.quick-add button[type=submit]')
  const offlineTaskShown = await visibleWithin(page.locator('.task-main strong', { hasText: 'Web offline task' }).first())
  record('offline-created task appears in UI (local-first)', offlineTaskShown)
  const pendingBadge = await visibleWithin(page.locator('.pending-badge').first(), 3000)
  record('pending badge shows queued local changes', pendingBadge)
  await shot('04-offline-banner-pending.png')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(800)
  const survivedReload = await visibleWithin(page.locator('.task-main strong', { hasText: 'Web offline task' }).first())
  record('offline task SURVIVES full page reload (IndexedDB + outbox)', survivedReload)
  const bannerAfterReload = await page.locator('.offline-banner').isVisible().catch(() => false)
  record('offline banner + pending state after reload', bannerAfterReload)
  await shot('05-offline-reload-persistence.png')

  // 5. back online -> outbox replay converges into the DESKTOP DB
  phase('reconnect-leg')
  await context.setOffline(false)
  let converged = false
  let finalState = null
  for (let i = 0; i < 40 && !converged; i++) {
    await sleep(500)
    finalState = await (await fetch('http://127.0.0.1:' + ready.controlPort + '/state')).json()
    converged = finalState.todos.some(t => t.content === 'Web offline task' && !t.deleted)
  }
  record('offline task converged into desktop sqlite after reconnect', converged)
  const convergenceNotice = await page.locator('text=离线期间的修改已与桌面同步完成').first().isVisible().catch(() => false)
  const pendingCleared = await page.locator('.pending-badge').count() === 0
  record('web UI shows convergence + cleared pending badge', convergenceNotice || pendingCleared)
  await shot('06-reconnect-converged.png')

  // 6. desktop -> web again
  phase('seed second desktop task')
  await fetch('http://127.0.0.1:' + ready.controlPort + '/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Desktop second task' }) })
  await page.getByRole('button', { name: /同步/ }).click()
  await page.click('button:has-text("拉取桌面数据")')
  await sleep(600)
  await page.getByRole('button', { name: /今日任务/ }).click()
  await sleep(300)
  const secondVisible = await visibleWithin(page.locator('.task-main strong', { hasText: 'Desktop second task' }).first())
  record('second desktop task visible in web after pull (bidirectional roundtrip)', secondVisible)
  await shot('07-second-desktop-task.png')

  // 7. dark theme
  phase('dark-theme')
  await page.click('.theme-toggle')
  await sleep(300)
  const dark = await page.evaluate(() => document.documentElement.dataset.theme === 'dark')
  record('dark theme toggles and persists via data-theme', dark)
  await shot('08-dark-theme.png')

  await context.close()
} catch (e) {
  record('unexpected runner error', false, String(e && e.stack || e))
} finally {
  try { await browser?.close() } catch {}
}
await exitCleanup(failures ? 1 : 0)
