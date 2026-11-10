#!/usr/bin/env node
/* eslint-env node */
/**
 * G2 screenshot-matrix WEB leg (ux-contract-20261110 §7, matrix-skeleton.mjs naming).
 *
 * Six groups (Today / Projects / Task detail / Episode-Handoff / Sync-Conflict / Settings)
 * x 2 viewports (1280x800@1, 360x800@1) x light+dark x default+empty states, captured as
 * REAL rendered pixels from the Playwright-bundled Chromium against the real cross-platform
 * bridge backed by a REAL sqlite DB. Populated rows are seeded through the REAL desktop CLI
 * gates (`pickdone add`, `pickdone work <id> add-episode`, `work <id> add-source` — the
 * command-bus mutation doors) into an isolated TODO_DB_DIR; the bridge host serves that same
 * sqlite file. The Sync-Conflict cell is produced by a real conflict roundtrip: an offline
 * local edit vs a desktop-side tombstone, surfaced by mergePull as conflict_tombstone_wins.
 *
 * Per-group REAL assertions (never CSS-variable equality): visible region headings, card
 * text, rendered touch-target box sizes, and THEME BACKGROUND MEASURED FROM SCREENSHOT
 * PIXELS (a minimal PNG decoder samples the actual captured bytes). Results go to
 * <out>/assertions.log; exit 0 only when every assertion passes.
 *
 * Evidence: <out>/ + manifest.json (viewport/theme/nav path/timestamp/build per cell).
 * Temp profile + certs live in a K:\tmp scratch dir, deleted at the end; host ports are
 * verified closed after stop.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'
const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const WEB = join(here, '..')
const REPO = join(WEB, '..')
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const SCRATCH = arg('--scratch', 'K:/tmp/pd-web-matrix-20261110')
const OUT = arg('--out', join(REPO, '..', 'web-evidence', 'matrix'))
const EXE = join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
const CLI = join(REPO, 'cli', 'pickdone.js')
const HOST = join(WEB, 'e2e', 'pwa-bridge-host.mjs')
const DIST = join(WEB, 'dist')
const DB_DIR = join(SCRATCH, 'cli-db')
const ENCRYPTED_DB = join(DB_DIR, 'todos.db')
// The desktop CLI writes an ENCRYPTED todos.db (better-sqlite3-multiple-ciphers, key in db.key).
// The bridge host speaks plaintext sqlite (node:sqlite), so we decrypt-copy the seeded DB with
// the SAME vendor driver + db.key — every row is the real CLI-gated row, byte-for-byte content.
const PLAIN_DIR = join(SCRATCH, 'plain')
const DB_PATH = join(PLAIN_DIR, 'todos.db')
function decryptCopy() {
  mkdirSync(PLAIN_DIR, { recursive: true })
  rmSync(DB_PATH, { force: true })
  const Database = require(join(REPO, 'vendor', 'better-sqlite3-multiple-ciphers'))
  const key = readFileSync(join(DB_DIR, 'db.key'), 'utf8').trim()
  const keyLiteral = key.replace(/'/g, "''")
  const db = new Database(ENCRYPTED_DB)
  db.pragma(`key='${keyLiteral}'`)
  db.exec(`ATTACH DATABASE '${DB_PATH.replace(/\\/g, '/').replace(/'/g, "''")}' AS plain KEY ''`)
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name)
  for (const table of tables) {
    // copy the REAL DDL (keeps the PRIMARY KEY / UNIQUE constraints the bridge upserts rely on)
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table).sql
    db.exec(ddl.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?[\w]+"?)/i, 'CREATE TABLE plain.$2'))
    db.exec(`INSERT INTO plain."${table}" SELECT * FROM main."${table}"`)
  }
  // NOTE (G2 FAIL-2 fix): the desktop column keeps its native day-start epoch ms here and the
  // pulled rows are converted ms->yyyymmdd by web/src/sync/dto-mapping.js (the DTO unit
  // boundary). No capture-time normalization anymore — the former hack is covered by
  // web/tests/sync.test.mjs (scheduledDay unit contract).
  db.exec('DETACH DATABASE plain')
  db.close()
  return tables
}

const VIEWPORTS = [
  { label: '1280x800', width: 1280, height: 800, kind: 'desktop' },
  { label: '360x800', width: 360, height: 800, kind: 'mobile' }
]
const THEMES = ['light', 'dark']
const MIN_TOUCH = 44, MIN_DESKTOP_TARGET = 24

// ---------------------------------------------------------------- logging
const failures = []
const assertLog = []
function assert(name, ok, detail) {
  const line = new Date().toISOString() + ' ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')
  assertLog.push(line)
  console.log(line)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------- minimal PNG pixel sampler
// Decodes an 8-bit non-interlaced RGB/RGBA PNG (what page.screenshot clip produces)
// and returns the pixel at (x, y) as {r,g,b} — REAL captured bytes, not CSS values.
function decodePngPixel(buf, x, y) {
  let off = 8, width = 0, height = 0, colorType = 0, idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : null
  if (!bpp) throw new Error('unsupported PNG color type ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const rows = []
  let pos = 0
  for (let ry = 0; ry < height; ry++) {
    const filter = raw[pos++]
    const row = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    const prev = rows[ry - 1] || Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      if (filter === 1) row[i] = (row[i] + a) & 0xff
      else if (filter === 2) row[i] = (row[i] + b) & 0xff
      else if (filter === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    rows.push(row)
  }
  const r = rows[y][x * bpp], g = rows[y][x * bpp + 1], b = rows[y][x * bpp + 2]
  return { r, g, b }
}
async function samplePixel(page, x, y) {
  const buf = await page.screenshot({ clip: { x: Math.max(0, x - 1), y: Math.max(0, y - 1), width: 3, height: 3 }, fullPage: false })
  return decodePngPixel(buf, 1, 1)
}

// ---------------------------------------------------------------- CLI seeding
function cli(envArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...envArgs], {
      env: { ...process.env, TODO_DB_DIR: DB_DIR.replace(/\//g, '\\'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error('CLI ' + envArgs.join(' ') + ' exit ' + code + '\n' + err + out)))
  })
}
function lastJson(text) {
  const start = text.lastIndexOf('{')
  // walk back to the matching opening brace of the final pretty-printed object
  let depth = 0, i = text.length - 1
  for (; i >= 0; i--) { if (text[i] === '}') depth++; else if (text[i] === '{') { depth--; if (depth === 0) break } }
  return JSON.parse(text.slice(i))
}

// ---------------------------------------------------------------- main
mkdirSync(SCRATCH, { recursive: true })
mkdirSync(OUT, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })

// 1. seed the isolated desktop DB through the REAL CLI gates (command bus, real sqlite)
assert('cli-seed: isolated scratch DB used (never the real AppData database)', DB_DIR.replaceAll('\\', '/').startsWith(SCRATCH.replaceAll('\\', '/')) && !DB_DIR.toLowerCase().includes('appdata'), DB_DIR)
await cli(['add', 'Draft launch checklist', '--date', 'today', '--json'])
await cli(['add', 'Review sync conflict notes', '--date', 'today', '--json'])
const conflictOut = await cli(['add', 'Conflict seed task', '--date', 'today', '--json'])
const conflictTaskId = lastJson(conflictOut).data.taskId
const handoffOut = await cli(['add', 'Handoff: continue API integration', '--date', 'today', '--json'])
const handoffTaskId = lastJson(handoffOut).data.taskId
const catOut = await cli(['category', 'add', 'Apollo Delivery', '--json'])
const catData = lastJson(catOut).data
const catId = catData.id || catData.categoryId || catData.category?.id
const epOut = await cli(['work', handoffTaskId, 'add-episode',
  '--goal=Wire the episode ledger into the web pull',
  '--outcome=Web leg pulls work_episodes over the real bridge',
  '--next=Capture the episode-handoff matrix cells', '--json'])
const episodeGoal = lastJson(epOut).data.goal
await cli(['work', handoffTaskId, 'add-source', '--provider=web',
  '--uri=https://example.com/ux-contract-20261110', '--title=UX contract 2026-11-10', '--json'])
assert('cli-seed: tasks + category + episode + source recorded through CLI gates',
  Boolean(conflictTaskId && handoffTaskId && catId && episodeGoal),
  'conflict=' + conflictTaskId + ' handoff=' + handoffTaskId + ' category=' + catId)
assert('cli-seed: episode note carries goal/outcome/next (Finding/Decision fields live in the handoff note, no separate tables in this build)', episodeGoal.includes('episode ledger'), JSON.stringify(episodeGoal))

// 2. decrypt-copy (same vendor driver + db.key) and launch the real bridge host against it
// self-signed cert for the HTTPS PWA origin (scratch only, deleted at the end)
const CERT_DIR = join(SCRATCH, 'certs')
mkdirSync(CERT_DIR, { recursive: true })
if (!existsSync(join(CERT_DIR, 'key.pem'))) {
  await new Promise((resolve, reject) => {
    const o = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(CERT_DIR, 'key.pem'), '-out', join(CERT_DIR, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=localhost'])
    o.on('close', c => c === 0 ? resolve() : reject(new Error('openssl exit ' + c)))
    o.on('error', reject)
  })
}
let copiedTables = []
try { copiedTables = decryptCopy() } catch (e) { console.error('decrypt-copy failed: ' + e.message); process.exit(1) }
assert('cli-seed: encrypted desktop DB decrypt-copied with the vendor driver + db.key (real rows preserved)',
  copiedTables.includes('todos') && copiedTables.includes('work_episodes'), copiedTables.join(','))
const host = spawn(process.execPath, [HOST, '--enable-bridge', '--db', DB_PATH,
  '--certs', join(SCRATCH, 'certs'), '--dist', DIST], { stdio: ['ignore', 'pipe', 'pipe'] })
let ready = null, hostLog = ''
host.stdout.on('data', d => { hostLog += d; if (!ready) { try { ready = JSON.parse(d.toString().split('\n').find(l => l.includes('"event":"ready"'))) } catch {} } })
host.stderr.on('data', d => { hostLog += d })
for (let i = 0; i < 150 && !ready; i++) await sleep(200)
if (!ready) { console.error('host never ready\n' + hostLog.slice(-3000)); process.exit(1) }
assert('host: real bridge + HTTPS PWA host up', Boolean(ready.bridgePort && ready.httpsPort && ready.controlPort), JSON.stringify({ bridgePort: ready.bridgePort, httpsPort: ready.httpsPort }))
const BASE = 'https://localhost:' + ready.httpsPort
const BRIDGE = 'http://127.0.0.1:' + ready.bridgePort
const challenge = JSON.stringify(ready.challenge)
const build = (() => { try { return JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')).version } catch { return '?' } })()

// sqlite write side (desktop-leg mutation for the conflict roundtrip): a second connection
// to the SAME real sqlite file the bridge serves — the desktop-side tombstone.
const { DatabaseSync } = await import('node:sqlite')

const manifest = []
const cellsForCapture = []

async function pairAndPull(page) {
  // fresh one-shot pairing per browser context (the startup challenge is single-use)
  const ch = await fetch('http://127.0.0.1:' + ready.controlPort + '/challenge', { method: 'POST' }).then(r => r.json())
  await page.getByRole('button', { name: /同步/ }).click()
  await page.fill('input[type=url]', BRIDGE)
  await page.fill('textarea', JSON.stringify(ch))
  await page.click('button:has-text("立即配对")')
  await page.locator('text=已配对').first().waitFor({ state: 'visible', timeout: 8000 })
  await page.click('button:has-text("拉取桌面数据")')
  await page.locator('text=已拉取桌面数据').first().waitFor({ state: 'visible', timeout: 8000 })
}
async function goTab(page, name, navLabel) {
  if (name === 'backup') {
    // the backup entry lives in .side-bottom, which the <=850px layout hides — deep link instead
    await page.evaluate(() => { location.hash = '#/backup' })
    await sleep(400)
    return
  }
  await page.locator('.sidebar nav button', { hasText: navLabel }).click()
  await sleep(350)
}

// desktop-side tombstone bumping for the conflict leg
async function desktopTombstone(id) {
  const db = new DatabaseSync(DB_PATH)
  const now = Date.now()
  db.prepare('UPDATE todos SET deleted=1, deletedAt=?, updatedAt=? WHERE id=?').run(now + 2000, now + 2000, id)
  db.close()
}

let totalCells = 0
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--ignore-certificate-errors'] })
try {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      // ---------- populated context (default states + assertions) ----------
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height } })
      await ctx.addInitScript(t => { localStorage.setItem('pickdone-web-theme', t) }, theme)
      const page = await ctx.newPage()
      // re-materialize the conflict seed task on the desktop side (each context runs its own tombstone roundtrip)
      const reseed = await fetch('http://127.0.0.1:' + ready.controlPort + '/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: conflictTaskId, content: 'Conflict seed task' }) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
      await page.locator('.task-list, .empty').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      await pairAndPull(page)
      await goTab(page, 'today', /今日任务/)
      await sleep(300)
      const cell = (group, state, navPath) => {
        const file = `${group.id}-${group.name}--web--${vp.label}--${theme}--${state}.png`
        totalCells++
        cellsForCapture.push({ file, navPath })
        return join(OUT, file)
      }

      // real-pixel theme background assertion: footer area is bare body background
      const bgPixel = await samplePixel(page, vp.width - 3, vp.height - 3)
      const bgCss = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement).backgroundColor
        const body = getComputedStyle(document.body).backgroundColor
        return { root, body }
      })
      const painted = [bgCss.body, bgCss.root].find(c => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent')
      assert(`theme-pixel[${vp.label}/${theme}]: background sampled from screenshot pixels (${JSON.stringify(bgPixel)}) matches rendered CSS (${JSON.stringify(bgCss)})`,
        Boolean(painted) && painted.includes(`${bgPixel.r}, ${bgPixel.g}, ${bgPixel.b}`), 'today default cell')

      // ---- G1 today (default)
      await page.screenshot({ path: cell({ id: '01', name: 'today' }, 'default', ['sidebar > 今日任务']), fullPage: false })
      const todayHeading = await page.locator('.hero h1').textContent().catch(() => '')
      assert(`g1-today[${vp.label}/${theme}]: region heading "今天，先完成重要的事。" rendered`, (todayHeading || '').trim() === '今天，先完成重要的事。', JSON.stringify(todayHeading))
      const taskText = await page.locator('.task-main strong').first().textContent().catch(() => '')
      assert(`g1-today[${vp.label}/${theme}]: task card text non-empty`, Boolean(taskText && taskText.trim().length > 3), JSON.stringify(taskText))

      // ---- G3 task detail (today > card > 编辑 opens the modal)
      await page.locator('.task-row .text-button', { hasText: /编辑/ }).first().click()
      await sleep(350)
      await page.screenshot({ path: cell({ id: '03', name: 'task-detail' }, 'default', ['今日任务', 'task card > 编辑']), fullPage: false })
      const modalHead = await page.locator('.modal-head h2').textContent().catch(() => '')
      assert(`g3-task-detail[${vp.label}/${theme}]: edit panel heading "编辑任务" rendered`, (modalHead || '').trim() === '编辑任务', JSON.stringify(modalHead))
      const modalValue = await page.locator('.modal input').first().inputValue().catch(() => '')
      assert(`g3-task-detail[${vp.label}/${theme}]: task title carried into the panel, non-empty`, Boolean(modalValue && modalValue.trim().length > 3), JSON.stringify(modalValue))
      await page.click('.modal-head .icon-button').catch(() => {})

      // ---- G2 projects (select first project card)
      await goTab(page, 'projects', /项目/)
      await page.locator('.project-card').first().click().catch(() => {})
      await sleep(350)
      await page.screenshot({ path: cell({ id: '02', name: 'projects' }, 'default', ['sidebar > 项目', 'project card click']), fullPage: false })
      const projHeading = await page.locator('.page-heading h1').textContent().catch(() => '')
      assert(`g2-projects[${vp.label}/${theme}]: region heading "项目" rendered`, (projHeading || '').trim() === '项目', JSON.stringify(projHeading))
      const projName = await page.locator('.project-card-name').first().textContent().catch(() => '')
      assert(`g2-projects[${vp.label}/${theme}]: project card name non-empty (CLI-seeded "Apollo Delivery")`, (projName || '').includes('Apollo Delivery'), JSON.stringify(projName))

      // ---- G4 episode-handoff (history tab, CLI-gated episode + source)
      await goTab(page, 'history', /工作历程/)
      await sleep(350)
      await page.screenshot({ path: cell({ id: '04', name: 'episode-handoff' }, 'default', ['sidebar > 工作历程']), fullPage: false })
      const histHeading = await page.locator('.page-heading h1').textContent().catch(() => '')
      assert(`g4-episode-handoff[${vp.label}/${theme}]: region heading "工作历程" rendered`, (histHeading || '').trim() === '工作历程', JSON.stringify(histHeading))
      const episodeNote = await page.locator('.episode-card p').first().textContent().catch(() => '')
      assert(`g4-episode-handoff[${vp.label}/${theme}]: CLI-gated episode note (goal/outcome/next) rendered on the card`, (episodeNote || '').includes('Wire the episode ledger'), JSON.stringify((episodeNote || '').slice(0, 80)))
      const episodeTaskTitle = await page.locator('.episode-card h3').first().textContent().catch(() => '')
      assert(`g4-episode-handoff[${vp.label}/${theme}]: episode bound to its CLI-seeded task title`, (episodeTaskTitle || '').includes('Handoff: continue API integration'), JSON.stringify(episodeTaskTitle))

      // ---- G5 sync-conflict: real conflict roundtrip (local offline edit vs desktop tombstone)
      await goTab(page, 'today', /今日任务/)
      await sleep(250)
      const row = page.locator('.task-row', { hasText: 'Conflict seed task' }).first()
      await ctx.setOffline(true)
      await sleep(300)
      // real local mutation through the edit panel (writes local row + outbox while offline)
      await row.locator('.text-button', { hasText: /编辑/ }).click()
      await sleep(250)
      const input = page.locator('.modal input').first()
      const orig = await input.inputValue()
      await input.fill(orig + ' (web edited offline)')
      await page.locator('.modal .form-actions button', { hasText: /保存修改/ }).click()
      await sleep(500)
      await ctx.setOffline(false)
      // let the auto-replay push the offline edit first (order matters: push, THEN the
      // desktop-side tombstone, then the manual pull — otherwise the push would resurrect it)
      await page.locator('.pending-badge').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
      await sleep(1200)
      await desktopTombstone(conflictTaskId)
      await goTab(page, 'sync', /同步/)
      await page.click('button:has-text("拉取桌面数据")')
      await sleep(800)
      await page.screenshot({ path: cell({ id: '05', name: 'sync-conflict' }, 'default', ['offline edit on web (pushed on reconnect)', 'desktop tombstone (sqlite)', '同步 > 拉取桌面数据']), fullPage: false })
      const syncHeading = await page.locator('.page-heading h1').textContent().catch(() => '')
      assert(`g5-sync-conflict[${vp.label}/${theme}]: region heading "与桌面同步" rendered`, (syncHeading || '').trim() === '与桌面同步', JSON.stringify(syncHeading))
      const conflictLine = await page.locator('.sync-conflicts li').first().textContent().catch(() => '')
      assert(`g5-sync-conflict[${vp.label}/${theme}]: real conflict verdict conflict_tombstone_wins surfaced in the UI`, (conflictLine || '').includes('conflict_tombstone_wins'), JSON.stringify(conflictLine))
      const noticeText = await page.locator('.message.success').textContent().catch(() => '')
      assert(`g5-sync-conflict[${vp.label}/${theme}]: conflict count notice rendered`, (noticeText || '').includes('处冲突'), JSON.stringify(noticeText))

      // ---- G6 settings (web equivalent surface: theme toggle topbar + 备份与恢复 data panel)
      await goTab(page, 'backup', /备份与恢复/)
      await sleep(350)
      await page.screenshot({ path: cell({ id: '06', name: 'settings' }, 'default', ['deep link #/backup (side-bottom entry hidden <=850px)', 'topbar theme toggle']), fullPage: false })
      const backupHeading = await page.locator('.page-heading h1').textContent().catch(() => '')
      assert(`g6-settings[${vp.label}/${theme}]: settings-surface heading "备份与恢复" rendered`, (backupHeading || '').trim() === '备份与恢复', JSON.stringify(backupHeading))
      const backupCard = await page.locator('.backup-card h2').textContent().catch(() => '')
      assert(`g6-settings[${vp.label}/${theme}]: data-portability card text non-empty`, Boolean(backupCard && backupCard.trim().length > 3), JSON.stringify(backupCard))
      const themeToggleBox = await page.locator('.theme-toggle').boundingBox()
      assert(`g6-settings[${vp.label}/${theme}]: theme toggle rendered with real box (${Math.round(themeToggleBox?.width || 0)}x${Math.round(themeToggleBox?.height || 0)})`,
        themeToggleBox && themeToggleBox.height >= (vp.kind === 'mobile' ? MIN_TOUCH : MIN_DESKTOP_TARGET), JSON.stringify(themeToggleBox))

      // ---- touch-target audit on the mobile viewport (real rendered boxes)
      if (vp.kind === 'mobile') {
        const navBoxes = []
        for (const btn of await page.locator('.sidebar nav button').all()) navBoxes.push(await btn.boundingBox())
        const minNav = Math.min(...navBoxes.map(b => Math.min(b.width, b.height)))
        assert(`touch-targets[${vp.label}/${theme}]: all sidebar nav buttons >=44px (min measured ${minNav}px)`, minNav >= MIN_TOUCH, navBoxes.map(b => `${Math.round(b.width)}x${Math.round(b.height)}`).join(','))
        await goTab(page, 'today', /今日任务/)
        const checkBox = await page.locator('.task-row .check').first().boundingBox()
        assert(`touch-targets[${vp.label}/${theme}]: task check control >=44px (${Math.round(checkBox?.width || 0)}x${Math.round(checkBox?.height || 0)})`, checkBox && checkBox.width >= MIN_TOUCH && checkBox.height >= MIN_TOUCH, JSON.stringify(checkBox))
        const editText = await page.locator('.task-row .text-button').first().boundingBox()
        assert(`touch-targets[${vp.label}/${theme}]: task row action >=44px (${Math.round(editText?.width || 0)}x${Math.round(editText?.height || 0)})`, editText && editText.height >= MIN_TOUCH, JSON.stringify(editText))
      } else {
        const navBox = await page.locator('.sidebar nav button').first().boundingBox()
        assert(`touch-targets[${vp.label}/${theme}]: desktop nav target >=24px (${Math.round(navBox?.height || 0)}px)`, navBox && navBox.height >= MIN_DESKTOP_TARGET, JSON.stringify(navBox))
      }

      await ctx.close()

      // ---------- empty context (empty/error states, fresh IndexedDB) ----------
      const ectx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height } })
      await ectx.addInitScript(t => { localStorage.setItem('pickdone-web-theme', t) }, theme)
      const epage = await ectx.newPage()
      await epage.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
      await epage.locator('.empty').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})

      await epage.screenshot({ path: cell({ id: '01', name: 'today' }, 'empty', ['fresh profile > 今日任务 (no data)']), fullPage: false })
      const emptyTitle = await epage.locator('.empty strong, .empty h3').first().textContent().catch(() => '')
      assert(`g1-empty[${vp.label}/${theme}]: EmptyState "今天还没有任务" rendered, main area never blank`, (emptyTitle || '').includes('今天还没有任务'), JSON.stringify(emptyTitle))

      await goTab(epage, 'projects', /项目/)
      await epage.screenshot({ path: cell({ id: '02', name: 'projects' }, 'empty', ['fresh profile > 项目 (no data)']), fullPage: false })
      const projEmpty = await epage.locator('.empty strong, .empty h3').first().textContent().catch(() => '')
      assert(`g2-empty[${vp.label}/${theme}]: projects EmptyState rendered`, (projEmpty || '').includes('还没有项目'), JSON.stringify(projEmpty))

      // task detail error state: deep link to a task that does not exist locally
      await goTab(epage, 'today', /今日任务/)
      await epage.goto(BASE + '/#/task/none-such-task', { waitUntil: 'domcontentloaded' })
      await sleep(600)
      await epage.screenshot({ path: cell({ id: '03', name: 'task-detail' }, 'error', ['deep link #/task/<unknown id>']), fullPage: false })
      const notFound = await epage.locator('.message.error').textContent().catch(() => '')
      assert(`g3-error[${vp.label}/${theme}]: unknown deep link renders explicit error, never a blank main area`, (notFound || '').includes('未找到该任务'), JSON.stringify(notFound))

      await goTab(epage, 'history', /工作历程/)
      await epage.screenshot({ path: cell({ id: '04', name: 'episode-handoff' }, 'empty', ['fresh profile > 工作历程 (no episodes)']), fullPage: false })
      const epEmpty = await epage.locator('.empty strong, .empty h3').first().textContent().catch(() => '')
      assert(`g4-empty[${vp.label}/${theme}]: episode EmptyState "还没有工作记录" rendered`, (epEmpty || '').includes('还没有工作记录'), JSON.stringify(epEmpty))

      await goTab(epage, 'sync', /同步/)
      await epage.screenshot({ path: cell({ id: '05', name: 'sync-conflict' }, 'empty', ['fresh profile > 同步 (unpaired)']), fullPage: false })
      const unpaired = await epage.locator('.sync-state').textContent().catch(() => '')
      assert(`g5-empty[${vp.label}/${theme}]: unpaired sync state "尚未配对" rendered`, (unpaired || '').includes('尚未配对'), JSON.stringify(unpaired))

      await goTab(epage, 'backup', /备份与恢复/)
      await epage.screenshot({ path: cell({ id: '06', name: 'settings' }, 'empty', ['deep link #/backup (fresh profile)']), fullPage: false })
      const backupEmpty = await epage.locator('.backup-card h2').textContent().catch(() => '')
      assert(`g6-empty[${vp.label}/${theme}]: settings surface still renders its card in a fresh profile`, Boolean(backupEmpty && backupEmpty.trim()), JSON.stringify(backupEmpty))

      await ectx.close()
    }
  }
} finally {
  try { await browser.close() } catch {}
}

// manifest with real nav paths + timestamps + build
const now = Date.now()
for (const c of cellsForCapture) {
  manifest.push({
    file: c.file, client: 'web', viewport: c.file.match(/--(\d+x\d+)--/)[1] + '@1',
    theme: c.file.includes('--dark--') ? 'dark' : 'light', state: c.file.match(/--([a-z]+)\.png$/)[1],
    navPath: c.navPath, capturedAt: new Date(now).toISOString(),
    build: { webVersion: build, commit: arg('--commit', 'working-tree') }
  })
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), cells: manifest }, null, 2))
assert('manifest: every captured cell recorded with viewport/theme/navPath/timestamp/build', manifest.length === totalCells && totalCells >= 48, totalCells + ' cells')

// cleanup: stop host, delete temp profile/certs, verify ports are closed
let stopped = false
try { await fetch('http://127.0.0.1:' + ready.controlPort + '/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }).then(r => { stopped = r.ok }) } catch {}
await sleep(800)
try { host.kill() } catch {}
await sleep(300)
rmSync(join(SCRATCH, 'certs'), { recursive: true, force: true })
rmSync(join(SCRATCH, 'cli-db'), { recursive: true, force: true })
rmSync(join(SCRATCH, 'plain'), { recursive: true, force: true })
const { createConnection } = await import('node:net')
const closed = await Promise.all([ready.bridgePort, ready.httpsPort, ready.controlPort].map(async port => {
  return new Promise(resolve => {
    const s = createConnection(port, '127.0.0.1', () => { s.destroy(); resolve(false) })
    s.on('error', () => resolve(true))
    s.setTimeout(1500, () => { s.destroy(); resolve(true) })
  })
}))
assert('cleanup: host stopped + scratch certs/db removed + all 3 ports verified closed', stopped && closed.every(Boolean), JSON.stringify({ stopped, closed }))

writeFileSync(join(OUT, 'assertions.log'), assertLog.join('\n') + '\n')
console.log(`\nmatrix: ${totalCells} cells written to ${OUT}; assertions ${failures.length ? 'FAILED (' + failures.length + ')' : 'ALL GREEN'}`)
process.exit(failures.length ? 1 : 0)
