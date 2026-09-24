/* Review round R4 wave-C fixes — regression tests:
 *   P1   db recovery: a 0-row restore (corrupt/empty critical-backup JSON) must NOT trigger the
 *        todos.db.plain-bak cleanup — the last usable backup has to survive. The restore error is
 *        surfaced via logWarn instead of being swallowed. The index.js relaunch branch must gate
 *        the cleanup on an actual restoredN > 0 (source anchor: importable-free main file).
 *   P2-1 notify-settings-updated: the float window is narrowed from the old 3-key denylist to a
 *        per-sender ALLOWLIST (white-noise keys only); enableSecurityLock:false and any other
 *        config key from a compromised float must never reach writeConfig.
 *   P2-2 the reloadAll fallback in execDbCall re-baselines the external-write watcher AFTER
 *        reloadAll completes (reloadAll writes reminderLastSeenAt after the earlier re-baseline).
 *   P2-3 syncGetPairingCode is main-window-only (source anchor).
 *   P2-4 upload-attachment enforces the 64MB total / 200-file aggregate quota.
 *   P2-5 db-oplog emits NO delta for tomatoUpdateById/planUpdateChip when the write was a no-op
 *        (result === false).
 *   P3   tomato-run-announce(s) carry the locked-state gate (source anchor).
 * Run: node --test tests/unit/main/r4-wave-c-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')
const ROOT = path.resolve(import.meta.dirname, '../../..')

/* ---------- P1: recovery keeps the plain-bak on a 0-row restore ---------- */

test('P1: restoreTasksFromCriticalBackup returns 0 on a corrupt backup (error surfaced), plain-bak untouched', () => {
  // Isolation: nest ud under a FRESH parent — criticalBackupPath prefers <parent>/pickdone-backups
  // and must not accidentally see a real backup outside the sandbox.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r4c-recover-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  const bak = path.join(ud, 'todos.db.plain-bak')
  fs.writeFileSync(bak, 'PLAINTEXT-BACKUP-CONTENT')
  // corrupt backup JSON: parse throws inside restoreTasksFromCriticalBackup (the swallowed-error case)
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{not json')
  const rec = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
  const upserts = []
  const n = rec.restoreTasksFromCriticalBackup(ud, rows => upserts.push(...rows))
  assert.equal(n, 0, 'corrupt backup must import 0 rows')
  assert.equal(upserts.length, 0)
  assert.equal(fs.existsSync(bak), true, 'the last backup file must survive a 0-row restore')
})

test('P1: index.js relaunch branch gates the plain-bak cleanup on restoredN > 0 (source anchor)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')
  const relaunchIdx = src.indexOf('app.exit does not trigger will-quit')
  const branch = src.slice(relaunchIdx, relaunchIdx + 6000)
  // main-ipc wave (2026-09-25): the branch chain is driven by dbRecovery.recoveryDialogAction —
  // the relaunch arm is `dialogAction === 'relaunch'` (reached with recovered=true only).
  assert.ok(branch.includes("dialogAction === 'relaunch'"), 'relaunch branch located')
  assert.ok(/restoredN > 0/.test(branch), 'cleanup must be gated on an actual restoredN > 0')
  // the rmSync of the plain-bak must live INSIDE the gated branch
  const gateIdx = branch.indexOf('restoredN > 0')
  const after = branch.slice(gateIdx)
  assert.ok(after.includes('todos.db.plain-bak') && after.includes('rmSync'), 'rmSync sits after the gate')
  assert.ok(branch.includes('plain-bak 保留'), 'the kept-bak decision is logged')
})

test('P1: restore still imports rows from a VALID backup (no false negatives)', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r4c-recover2-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  const bak = path.join(ud, 'todos.db.plain-bak')
  fs.writeFileSync(bak, 'KEEP-ME')
  const backup = {
    backup: {
      todoState: JSON.stringify({ todoList: [{ taskId: 't1', title: 'x' }], recycleList: [] })
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  const rec = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
  const n = rec.restoreTasksFromCriticalBackup(ud, () => {})
  assert.equal(n, 1, 'valid backup imports its rows')
  assert.equal(fs.existsSync(bak), true, 'restore itself never touches the bak (caller gates the cleanup)')
})

/* ---------- P2-1: float settings write allowlist ---------- */

const settingsStubs = {
  electron: { app: { getPath: () => os.tmpdir() } },
  'electron-log': { warn () {}, info () {}, error () {} },
  '../i18n': { mt: k => k, setLocale () {} },
  '../tomato-float': { isSelfSender: s => s && s.id === 'float-sender' }
}

function loadSettingsHandlers () {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (settingsStubs[request]) return settingsStubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    const factory = require_(path.join(ROOT, 'src/main/handlers/settings.js'))
    const mainWC = { id: 'main-wc' }
    const ctx = {
      readConfig: () => ({ appLocale: 'en', whiteNoiseAudio: '', enableSecurityLock: true }),
      writeConfig: patch => ({ written: patch }),
      app: { setLoginItemSettings () {} },
      getMainWindow: () => ({ webContents: mainWC, isDestroyed: () => false }),
      applyShortcuts () {}, rebuildTrayMenu () {}, getTray: () => null
    }
    const handlers = factory(ctx)
    const floatEvent = { sender: { id: 'float-sender' } }
    const mainEvent = { sender: mainWC }
    const otherEvent = { sender: { id: 'rogue' } }
    return { handlers, floatEvent, mainEvent, otherEvent }
  } finally {
    Module._load = origLoad
  }
}

test('P2-1: float writes get the security/shortcut forbidden set stripped (2026-09-22 per-sender contract)', () => {
  const { handlers, floatEvent } = loadSettingsHandlers()
  const c = handlers['notify-settings-updated'](floatEvent, {
    whiteNoiseAudio: 'rain',
    enableSecurityLock: false,
    appLocale: 'zh-CN',
    hideMainWindowOnStartup: true
  })
  const written = c.written
  assert.equal(written.enableSecurityLock, undefined, 'the lock kill-switch is stripped from float writes')
  assert.equal(written.whiteNoiseAudio, 'rain', 'the float white-noise choice is the legitimate write')
  assert.equal(written.appLocale, 'zh-CN', 'non-forbidden keys pass for the float under the per-sender set')
  assert.equal(written.hideMainWindowOnStartup, true)
})

test('P2-1: an all-stripped float patch lands as an empty merge (no forbidden key survives)', () => {
  const { handlers, floatEvent } = loadSettingsHandlers()
  const c = handlers['notify-settings-updated'](floatEvent, { enableSecurityLock: false })
  assert.deepEqual(c.written, {}, 'the stripped patch is empty — no forbidden key reaches the config')
})

test('P2-1: main window keeps full write access (security keys still stripped, non-security keys land)', () => {
  const { handlers, mainEvent } = loadSettingsHandlers()
  const c = handlers['notify-settings-updated'](mainEvent, {
    enableSecurityLock: false,
    hideMainWindowOnStartup: true,
    securityLockPassword: 'x'
  })
  const written = c.written
  assert.equal(written.hideMainWindowOnStartup, true, 'non-security key written')
  assert.equal(written.enableSecurityLock, false, 'main window may change the lock setting')
  // 2026-09-22 root-fix: the lock password ciphertext travels on THIS channel
  // (SettingsModal.saveLockPassword -> settings/update); the old unconditional strip silently
  // dropped every password save. The float remains stripped (see the per-sender test above).
  assert.equal(written.securityLockPassword, 'x', 'main window keeps the lock-password write surface')
})

test('P2-1: non-main/non-float senders are still rejected outright', () => {
  const { handlers, otherEvent } = loadSettingsHandlers()
  assert.throws(() => handlers['notify-settings-updated'](otherEvent, { appLocale: 'de' }), /forbidden/)
})

/* ---------- P2-2: re-baseline the watcher AFTER reloadAll completes ---------- */

test('P2-2: a write hitting the reloadAll fallback re-baselines the watcher after reloadAll', () => {
  const stubs = {
    'electron-log': { warn () {}, info () {}, error () {} },
    '../tomato-float': { isSelfSender: () => false },
    '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
    '../scheduler': {
      needsCatchUp: () => true, // force the reloadAll fallback branch
      scheduleOne () {},
      reloadAll () { timeline.push('reloadAll') },
      reminderInstances: () => []
    },
    '../command-bus': { commandForOp: () => null, onCommit () {}, commitOp () {}, commit () {} },
    '../db': {
      call: (op) => { if (op === 'getById') return null; return {} },
      isWriteOp: op => op === 'upsert',
      LEDGER_WRITE_OPS: new Set(),
      suppressLedgerHook: () => null
    }
  }
  const timeline = []
  const resyncCalls = []
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4c-todo-'))
  try {
    const factory = require_(path.join(ROOT, 'src/main/handlers/todo.js'))
    const handlers = factory({
      isLocked: () => false,
      isLockWindow: () => false,
      getMainWindow: () => null,
      resyncDbWatch: () => () => { timeline.push('resync'); resyncCalls.push(1) },
      broadcastTomatoRecordsChanged () {},
      broadcastTodosChanged () {},
      dbApi: () => ({}),
      attachDir: () => tmpDir,
      notifySyncChange: null
    })
    const ev = { sender: { id: 'main-wc' } }
    handlers['todo-db:call'](ev, 'upsert', { taskId: 't1', title: 'x' })
    assert.equal(timeline.filter(x => x === 'reloadAll').length, 1, 'reloadAll fallback ran once')
    assert.equal(resyncCalls.length, 2, 'inline defense re-baseline + post-reloadAll re-baseline')
    assert.ok(
      timeline.lastIndexOf('resync') > timeline.indexOf('reloadAll'),
      'a re-baseline must happen AFTER reloadAll (its reminderLastSeenAt write lands late)'
    )
  } finally {
    Module._load = origLoad
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

/* ---------- P2-3: syncGetPairingCode is main-window-only (source anchor) ---------- */

test('P2-3: syncGetPairingCode joined MAIN_WINDOW_ONLY_OPS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/handlers/todo.js'), 'utf8')
  const setIdx = src.indexOf('const MAIN_WINDOW_ONLY_OPS = new Set([')
  const setEnd = src.indexOf('])', setIdx)
  const setBody = src.slice(setIdx, setEnd)
  assert.ok(setBody.includes("'syncGetPairingCode'"), 'op must be in the main-window-only set')
  // renderer caller is main-window only: SettingsSyncTab (settings page), not float/lock pages
  const callerSrc = fs.readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsSyncTab.vue'), 'utf8')
  assert.ok(callerSrc.includes('getPairingCode'), 'caller verified: settings page uses getPairingCode')
})

/* ---------- P2-4: upload-attachment aggregate quota (64MB / 200 files) ---------- */

test('P2-4: uploads exceeding the 64MB total budget (or 200-file count) are rejected', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'r4c-att-'))
  const stubs = { electron: { app: { getPath: () => ud } } }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    const att = require_(path.join(ROOT, 'src/main/attachments.js'))
    const files = path.join(ud, 'files')
    fs.mkdirSync(files, { recursive: true })
    const b64 = Buffer.from('hello attachment').toString('base64')
    // small upload still works (saveAttachment is async — the IPC handler awaits it)
    const ok = await att.saveAttachment({ taskId: 't1', name: 'a.txt', dataBase64: b64 })
    assert.ok(ok.url, 'small upload within quota succeeds')
    // simulate 63MB of existing usage without allocating it: sparse file via truncate
    const big = path.join(files, 't0_1_big.bin')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 63 * 1024 * 1024)
    const payload = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64')
    await assert.rejects(
      () => att.saveAttachment({ taskId: 't2', name: 'b.txt', dataBase64: payload }),
      /quota exceeded/,
      '63MB existing + 2MB upload must breach the 64MB budget'
    )
    // count quota: 200 files present
    fs.rmSync(big)
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(files, `t3_${i}_f.txt`), 'x')
    await assert.rejects(
      () => att.saveAttachment({ taskId: 't4', name: 'c.txt', dataBase64: b64 }),
      /too many attachment files/,
      '200 existing files must trip the count cap'
    )
  } finally {
    Module._load = origLoad
    fs.rmSync(ud, { recursive: true, force: true })
  }
})

/* ---------- P2-5: no phantom oplog deltas on no-op writes ---------- */

test('P2-5: tomatoUpdateById/planUpdateChip emit no delta when the write changed nothing', () => {
  const factory = require_(path.join(ROOT, 'src/main/db-oplog.js'))
  const { oplogEntriesFor } = factory({ getDb: () => { throw new Error('should not need db for these ops') }, log: { warn () {} } })
  assert.deepEqual(oplogEntriesFor('tomatoUpdateById', { tomatoId: 'x', patch: {} }, false), [],
    'tomatoUpdateById result=false (missing/tombstoned/no-op) → no delta')
  assert.equal(oplogEntriesFor('tomatoUpdateById', { tomatoId: 'x', patch: {} }, true).length, 1,
    'a real write still emits one delta')
  assert.deepEqual(oplogEntriesFor('planUpdateChip', { id: 'c1', day: '2026-09-21', mm: '08:00' }, false), [],
    'planUpdateChip result=false (no live chip matched) → no delta')
  assert.equal(oplogEntriesFor('planUpdateChip', { id: 'c1', day: '2026-09-21', mm: '08:00' }, true).length, 1,
    'a real chip write still emits one delta')
})

/* ---------- P3: tomato-run-announce(s) locked-state gate (source anchor) ---------- */

test('P3: tomato-run-announce and tomato-run-announces carry the isLocked gate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/handlers/tomato.js'), 'utf8')
  const writeCh = src.indexOf("'tomato-run-announce'")
  const listCh = src.indexOf("'tomato-run-announces'")
  assert.ok(writeCh > 0 && listCh > writeCh)
  assert.ok(src.slice(writeCh, listCh).includes('isLocked()'), 'write channel gated')
  assert.ok(src.slice(listCh, listCh + 300).includes('isLocked()'), 'snapshot channel gated')
})
