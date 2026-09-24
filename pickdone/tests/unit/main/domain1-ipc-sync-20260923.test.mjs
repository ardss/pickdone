/* Domain-1 fix round (2026-09-23) — sync & IPC security surface regressions:
 *   F-A1  machine-level config keys (enableSecurityLock/shortcutKeySettings/runWhenComputerStart/
 *         hideMainWindowOnStartup) are machine-local settings rows on BOTH sync ends
 *         (shared/machine-local-keys.mjs is the single source; manifest and sync-apply import it).
 *   F-A2  LAN attachment receiver enforces the SAME extension whitelist as the upload door —
 *         script-capable files (.svg/.html/no-ext) are refused into the failed-set, never land.
 *   F-A3  settingsRowPut/PutMany/Delete are MAIN_WINDOW_ONLY — a non-main-window sender is
 *         rejected at the todo-db:call / commands:commit door.
 *   F-A4  tomato-announce attachTodoTitle/Id are sanitized + truncated (control chars stripped,
 *         120-char cap) on the local write AND on remote parse-back.
 *   F-A5  float dragStop/setPanelOpen reject senders that are not the float's own webContents
 *         (symmetric with dragStart).
 *   F-A6  shared formatMMSS clamps negatives (a -1 remainSec renders "00:00", never "-1:-1");
 *         both main-process mm:ss sites consume it.
 * Run: node --test tests/unit/main/domain1-ipc-sync-20260923.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'domain1-fix-'))
const sha = buf => createHash('sha256').update(buf).digest('hex')

/* ---------- F-A1: shared machine-local settings-key predicate ---------- */
test('F-A1 shared predicate: machine-level config keys are machine-local, user keys are not', async () => {
  const shared = await import('../../../shared/machine-local-keys.mjs')
  for (const k of ['enableSecurityLock', 'shortcutKeySettings', 'runWhenComputerStart',
    'hideMainWindowOnStartup', 'sync.deviceId', 'securityLockPassword', '_cliLastSeen']) {
    assert.equal(shared.isMachineLocalSettingKey(k), true, k + ' must be machine-local')
  }
  // user-data rows must stay syncable (predicate only tightened, never loosened)
  for (const k of ['appLocale', 'closeActionMinimize', 'enableTomatoFloating', 'habits']) {
    assert.equal(shared.isMachineLocalSettingKey(k), false, k + ' must stay syncable')
  }
})

test('F-A1 single source: sync-apply and command-manifest use the SAME shared function', async () => {
  const shared = await import('../../../shared/machine-local-keys.mjs')
  const manifest = require_('../../../src/main/command-manifest.js')
  const syncApply = require_('../../../src/main/sync-apply.js')
  assert.equal(manifest.isMachineLocalSettingKey, shared.isMachineLocalSettingKey)
  assert.equal(syncApply.isMachineLocalSettingKey, shared.isMachineLocalSettingKey)
  // the exact attack key from the finding: the old regex missed it
  assert.equal(shared.isMachineLocalSettingKey('enableSecurityLock'), true)
})

/* ---------- F-A2: LAN receiver extension whitelist ---------- */
function memDeps () {
  const written = []
  return {
    written,
    deps: {
      exists: key => written.some(w => w.key === key),
      size: key => 0,
      read: (key, start, end) => Buffer.alloc(0),
      writeAtomic: (key, buf) => { written.push({ key, buf }); return true },
      hashFn: sha,
    },
  }
}
function frameFile (id, buf) {
  const out = [{ type: 'att-meta', id, size: buf.length, hash: sha(buf) }]
  out.push({ type: 'att-chunk', id, index: 0, data: buf.toString('base64'), final: true })
  return out
}
test('F-A2 receiver refuses script-capable extensions, accepts whitelisted ones', () => {
  const att = require_('../../../src/main/lan-sync/att-transfer.js')
  const { deps, written } = memDeps()
  const session = { failed: new Map(), requests: new Map() }
  const ids = ['evil.svg', 'evil.html', 'noext', 'pic.png']
  const puller = att.createAttachmentPuller({
    deps, session, maxFiles: 10, maxBytes: 64 * 1024 * 1024,
    getKeys: () => ids, send: () => true,
  })
  assert.equal(puller.maybeStart(() => {}, () => {}), true) // att-req out, batch armed
  for (const id of ids) for (const m of frameFile(id, Buffer.from('data-' + id))) puller.onMessage(m)
  puller.onMessage({ type: 'att-end', sent: 0, missing: 0 })
  const landed = written.map(w => w.key)
  assert.deepEqual(landed, ['pic.png']) // ONLY the whitelisted file touched the disk
  for (const bad of ['evil.svg', 'evil.html', 'noext']) {
    assert.ok(session.failed.has(bad), bad + ' must be in the per-session failed-set (no retry loop)')
  }
  assert.ok(!session.failed.has('pic.png'))
})

/* ---------- F-A4: announce title sanitization ---------- */
test('F-A4 buildAnnounceValue strips control chars and truncates attachTodoTitle', () => {
  const ta = require_('../../../src/main/tomato-announce.js')
  const hostile = 'A\nB\u202eC\u0007' + 'x'.repeat(300)
  const v = ta.buildAnnounceValue({ deviceId: 'd1', deviceName: 'D', status: 'running', startedAt: 1, plannedSec: 10, attachTodoId: 't1', attachTodoTitle: hostile })
  assert.ok(v.attachTodoTitle.length <= 120, 'title must be truncated to 120')
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we assert is stripped
  assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(v.attachTodoTitle), 'no control/RTL chars')
  // parse-back of a REMOTE hostile value hits the same choke point (single sanitizer)
  const raw = JSON.stringify({ deviceId: 'd2', deviceName: 'D', status: 'running', startedAt: 1, plannedSec: 10, attachTodoId: 't2', attachTodoTitle: hostile })
  const p = ta.parseAnnounce(raw)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we assert is stripped
  assert.ok(p && p.attachTodoTitle.length <= 120 && !/[\u0000-\u001f\u202a-\u202e]/.test(p.attachTodoTitle))
  // clean title passes through unchanged (no over-sanitization)
  const clean = ta.buildAnnounceValue({ deviceId: 'd', status: 'running', startedAt: 1, plannedSec: 5, attachTodoId: 't', attachTodoTitle: 'Report' })
  assert.equal(clean.attachTodoTitle, 'Report')
  // review follow-up: deviceName/deviceId are peer-controlled too and deviceName is rendered
  // verbatim in peer UI chips — same sanitize+cap choke point applies
  const hostileName = 'N\u202eX\u0007' + 'y'.repeat(200)
  const v2 = ta.buildAnnounceValue({ deviceId: 'dev\u0001-x', deviceName: hostileName, status: 'running', startedAt: 1, plannedSec: 5 })
  assert.ok(v2.deviceName.length <= 40 && !/[\u0000-\u001f\u202a-\u202e]/.test(v2.deviceName), 'deviceName sanitized + capped at 40') // eslint-disable-line no-control-regex -- the regex intentionally matches control characters
  assert.ok(v2.deviceId.length <= 128 && !/[\u0000-\u001f]/.test(v2.deviceId), 'deviceId sanitized + capped') // eslint-disable-line no-control-regex -- the regex intentionally matches control characters
  // legit identity passes through unchanged
  const v3 = ta.buildAnnounceValue({ deviceId: '0f8a-uuid', deviceName: '书房台式机', status: 'idle' })
  assert.equal(v3.deviceName, '书房台式机')
  assert.equal(v3.deviceId, '0f8a-uuid')
})

/* ---------- F-A6: shared formatMMSS ---------- */
test('F-A6 formatMMSS clamps negatives/fractions; both main-process sites consume it', async () => {
  const { formatMMSS } = await import('../../../shared/format-mmss.cjs')
  assert.equal(formatMMSS(-1), '00:00') // the finding: old tray copy rendered "-1:-1"
  assert.equal(formatMMSS(-0.5), '00:00')
  assert.equal(formatMMSS(0), '00:00')
  assert.equal(formatMMSS(75), '01:15')
  assert.equal(formatMMSS(3725), '62:05') // mm may exceed 59 (taskbar semantics preserved)
  assert.equal(formatMMSS('abc'), '00:00')
  // source anchors: the two inline copies are gone, the shared module is required
  const tomatoSrc = fs.readFileSync(new URL('../../../src/main/handlers/tomato.js', import.meta.url), 'utf8')
  const taskbarSrc = fs.readFileSync(new URL('../../../src/main/tomato-taskbar.js', import.meta.url), 'utf8')
  assert.ok(tomatoSrc.includes("require('../../../shared/format-mmss.cjs')"))
  assert.ok(taskbarSrc.includes("require('../../shared/format-mmss.cjs')"))
  assert.ok(!taskbarSrc.includes("padStart(2, '0')"), 'no hand-rolled mm:ss remains in tomato-taskbar')
})

/* ---------- F-A3 + F-A5: IPC sender gates (real modules, electron stubbed) ---------- */
const electronStub = {
  app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
  BrowserWindow: class {},
  Notification: class { show () {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) },
}
const stubs = { electron: electronStub }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const realDb = require_('../../../src/main/db.js')
realDb.init(process.env.TODO_DB_DIR)

test('F-A3 settings row writes are main-window-only at the todo-db:call door', () => {
  const todoHandlers = require_('../../../src/main/handlers/todo.js')
  const mainWc = { id: 1 }
  const ctx = {
    isLocked: () => false, isLockWindow: () => false,
    getMainWindow: () => ({ webContents: mainWc }),
    resyncDbWatch: () => null, broadcastTomatoRecordsChanged: () => {}, broadcastTodosChanged: () => {},
    dbApi: () => realDb, attachDir: () => process.env.TODO_DB_DIR, notifySyncChange: () => {},
  }
  const handlers = todoHandlers(ctx)
  const stranger = { sender: { id: 99 } } // a trapped float/quick-add/lock window
  for (const op of ['settingsRowPut', 'settingsRowPutMany', 'settingsRowDelete']) {
    assert.throws(() => handlers['todo-db:call'](stranger, op, { key: 'appLocale', value: 'en' }),
      /forbidden: main window only/, op + ' from a non-main window must be rejected')
  }
  // main-window sender passes the CAPABILITY gate (error, if any, is not the gate's)
  let gateError = null
  try { handlers['todo-db:call']({ sender: mainWc }, 'settingsRowPut', { key: '__gate_probe', value: '1' }) } catch (e) { gateError = e }
  assert.ok(!(gateError && /forbidden: main window only/.test(gateError.message)), 'main window must pass the gate')
})

test('F-A5 float dragStop/setPanelOpen reject foreign senders (symmetric with dragStart)', () => {
  const tomatoFloat = require_('../../../src/main/tomato-float.js')
  // Behavior (deny side is observable without an Electron window: win is null → no sender
  // counts as "self"): a foreign/absent sender is REJECTED (false), never allowed through.
  assert.equal(tomatoFloat.dragStop({ id: 99 }), false, 'foreign sender must NOT stop a drag')
  assert.equal(tomatoFloat.setPanelOpen({ id: 99 }, true), false, 'foreign sender must NOT flip the panel')
  // Allow side needs a live BrowserWindow (Electron-only): pin the guard wiring by source —
  // both entries must route through isSelfSender, the same check dragStart uses.
  const src = fs.readFileSync(new URL('../../../src/main/tomato-float.js', import.meta.url), 'utf8')
  const dragStop = src.slice(src.indexOf('dragStop (sender)'))
  const setPanel = src.slice(src.indexOf('setPanelOpen (sender, open)'))
  assert.ok(dragStop.includes('isSelfSender(sender)'), 'dragStop must gate on isSelfSender')
  assert.ok(setPanel.includes('isSelfSender(sender)'), 'setPanelOpen must gate on isSelfSender')
})
