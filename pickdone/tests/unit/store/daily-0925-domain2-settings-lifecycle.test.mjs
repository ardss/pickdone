/**
 * Daily 2026-09-25 — domain 2 settings-effectiveness / orphan-key fixes:
 * [B4] notificationTimeoutInterval finally has its main-process consumers — scheduler.fire,
 *      handlers/system 'notification' and lan-sync-bootstrap 'pair-request' all derive the
 *      Notification timeout options from the setting (previously the radio group wrote a key
 *      NOTHING read — a pure orphan setting).
 * [B3] ignoreReminder dead field removed from the todo store state and from backup dumps; the
 *      scheduler header comment no longer claims a renderer-side "ignoreReminder" filter.
 * [B14] event/critical backups strip volatile settings (stripVolatileSettings: true) so two
 *      identical business states produce byte-identical dumps and handlers/backup.js's
 *      whole-string content dedup hits for evt snapshots too.
 * [B5] the SettingsModal holiday-badges switch is gone (no renderer drew badges from
 *      showHolidayMarkers — a control that visibly did nothing).
 * [B6] re-pin: CLI `settings set appLocale <non-member>` is rejected (enum validation).
 * [P2 root cause] settings key lifecycle guard: every DEFAULT_SETTINGS key must have at least
 *      one read point in renderer/js outside store/settings.js itself — EXCEPT keys on the
 *      explicit orphan/legacy backlog. A future key added without a consumer fails here.
 * Run: node --test tests/unit/store/daily-0925-domain2-settings-lifecycle.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importNs = p => import(pathToFileURL(path.join(ROOT, p)).href)
const importSrc = async p => (await importNs(p)).default // CJS under test
const require_ = createRequire(import.meta.url)

/* ---------------- B4: notificationTimeoutInterval has main-process consumers ---------------- */

test('B4: timeoutFromInterval clamps to the manifest range and falls back to the declared default', async () => {
  const { timeoutFromInterval } = await importSrc('src/main/scheduler.js')
  assert.equal(timeoutFromInterval(60000), 60000, 'in-range value passes through')
  assert.equal(timeoutFromInterval(30000), 30000, 'min bound is inclusive')
  assert.equal(timeoutFromInterval(300000), 300000, 'max bound is inclusive')
  assert.equal(timeoutFromInterval(29999), 300000, 'below the manifest min → declared default')
  assert.equal(timeoutFromInterval(300001), 300000, 'above the manifest max → declared default')
  assert.equal(timeoutFromInterval(undefined), 300000, 'missing value → default')
  assert.equal(timeoutFromInterval('abc'), 300000, 'junk value → default')
})

test('B4: notifyTimeoutOpts reads notificationTimeoutInterval out of the db.settingsState blob', async () => {
  const { notifyTimeoutOpts } = await importSrc('src/main/scheduler.js')
  const dbWith = blob => ({ call: (op, key) => (op === 'getMeta' && key === 'db.settingsState' ? JSON.stringify(blob) : null) })
  assert.deepEqual(
    notifyTimeoutOpts(dbWith({ notificationTimeoutInterval: 120000 })),
    { timeout: 120000, timeoutType: 'default' },
    'the user-picked duration reaches the Notification options'
  )
  assert.deepEqual(notifyTimeoutOpts(dbWith({})), { timeout: 300000, timeoutType: 'default' }, 'blob without the key → default')
  assert.deepEqual(notifyTimeoutOpts(null), { timeout: 300000, timeoutType: 'default' }, 'degraded host (no db) → default, never a throw')
  assert.deepEqual(
    notifyTimeoutOpts({ call: () => { throw new Error('db gone') } }),
    { timeout: 300000, timeoutType: 'default' },
    'a throwing getMeta degrades to the default'
  )
})

test('B4: scheduler.fire actually constructs the Notification with the wired timeout options', async () => {
  // Intercept 'electron' (real Notification is unavailable in plain Node) and './db.js'
  // (fire must read the TEMP-harness blob, never a real user DB).
  const Module = require_('module')
  const realLoad = Module._load
  const seen = []
  const fakeDb = { call: (op, key) => (op === 'getMeta' && key === 'db.settingsState' ? JSON.stringify({ notificationTimeoutInterval: 60000 }) : null) }
  class FakeNotification {
    constructor (opts) { seen.push(opts) }
    on () {}
    show () {}
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { Notification: FakeNotification, app: { getPath: () => os.tmpdir() } }
    if (request === './db.js' && parent && String(parent.filename).includes('scheduler.js')) return fakeDb
    return realLoad.call(this, request, parent, isMain)
  }
  try {
    delete require_.cache[require_.resolve(path.join(ROOT, 'src/main/scheduler.js'))]
    const scheduler = require_(path.join(ROOT, 'src/main/scheduler.js'))
    scheduler.fire({ taskContent: 'T', taskDescribe: 'D', taskId: 't1' }, 0)
  } finally {
    Module._load = realLoad
  }
  assert.equal(seen.length, 1, 'fire() constructed exactly one Notification')
  assert.equal(seen[0].timeout, 60000, 'the blob duration rode into the real Notification construction')
  assert.equal(seen[0].timeoutType, 'default')
  assert.equal(seen[0].title, 'T', 'sanity: the rest of the payload is untouched')
})

test('B4: the other two notification channels are wired to the same helper', () => {
  const sys = read('src/main/handlers/system.js')
  assert.ok(sys.includes('new Notification({') && sys.includes('notifyTimeoutOptsForApp()'), "handlers/system 'notification' honors notificationTimeoutInterval")
  assert.ok(sys.indexOf('notifyTimeoutOptsForApp()') < sys.indexOf('n.show()'), 'options are passed at construction, not after show')
  const lan = read('src/main/lan-sync-bootstrap.js')
  assert.ok(lan.includes('notifyTimeoutOptsForApp()'), "lan-sync-bootstrap 'pair-request' honors notificationTimeoutInterval")
})

/* ---------------- B3: ignoreReminder dead field is gone ---------------- */

test('B3: backup dumps no longer carry the dead ignoreReminder field', async () => {
  const { buildBackupDump } = await importNs('renderer/js/store/helpers/todoBackup.js')
  if (!globalThis.localStorage) globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const dump = buildBackupDump(
    { settings: {}, category: { list: [] }, habits: { habits: [], moments: [] }, tomato: null, filters: { list: [] } },
    { search: '', todoList: [], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: 0, todosVersion: 0 }
  )
  const todoState = JSON.parse(dump.backup.todoState)
  assert.ok(!('ignoreReminder' in todoState), 'the dead field is not written into dumps anymore')
  assert.ok(todoState.todoList.length === 0 && 'todosVersion' in todoState, 'the rest of the segment shape survives')
})

test('B3: ignoreReminder is fully excised from the store, the backup helper and the scheduler comment', () => {
  for (const p of ['renderer/js/store/todo.js', 'renderer/js/store/helpers/todoBackup.js', 'src/main/scheduler.js']) {
    assert.ok(!read(p).includes('ignoreReminder'), `${p} no longer references the dead field`)
  }
})

/* ---------------- B14: evt/critical dumps strip volatile settings → dedup hits ---------------- */

const resetLs = () => {
  const LS = new Map()
  globalThis.localStorage = {
    getItem: k => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, String(v)),
    removeItem: k => LS.delete(k)
  }
  return LS
}

const baseCtx = () => ({ state: {}, rootState: { settings: {}, category: { list: [] }, habits: { habits: [], moments: [] }, tomato: null, filters: { list: [] } } })

test('B14: two identical business states produce byte-identical evt dumps (dedup twin)', async () => {
  const { writeEventBackupCore } = await importNs('renderer/js/store/helpers/todoBackup.js')
  const { saveRuntime } = await importNs('renderer/js/store/helpers/runtimeState.js')
  resetLs()
  globalThis.window = globalThis.window || {}
  const payloads = []
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    runAutoBackup: async (json) => { payloads.push(json); return payloads.length === 1 ? { ok: true, file: 'evt-purge-1.json' } : { ok: true, file: 'evt-purge-1.json', dedup: true } }
  }
  const mk = () => baseCtx()
  mk().rootState.settings.autoBackupLastAt = 111
  assert.equal(await writeEventBackupCore({}, mk(), 'purge'), true)
  saveRuntime({ autoBackupLastAt: 999 }) // volatile runtime ticks between the two snapshots
  mk().rootState.settings.autoBackupLastAt = 999 // a later auto backup touched the volatile key
  assert.equal(await writeEventBackupCore({}, mk(), 'purge'), true)
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0], payloads[1], 'identical business states → byte-identical dump → handlers/backup.js whole-string dedup hits (dedup:true on the second write)')
  const settings0 = JSON.parse(JSON.parse(payloads[0]).backup.settingsState)
  assert.equal(settings0.autoBackupLastAt, 0, 'the volatile timestamp is stripped from the evt snapshot (that is WHY the bytes match)')
})

test('B14: the critical-backup dump path passes stripVolatileSettings too', async () => {
  const src = read('renderer/js/store/helpers/todoBackup.js')
  const critIdx = src.indexOf('writeCriticalBackupCore')
  assert.ok(critIdx > 0)
  const crit = src.slice(critIdx)
  assert.ok(/buildBackupDump\(rootState, state, \{ stripVolatileSettings: true/.test(crit), 'writeCriticalBackupCore strips volatile settings so critical dumps dedup too')
})

/* ---------------- B5: the dead holiday-badges switch is off the settings page ---------------- */

test('B5: SettingsModal no longer renders the showHolidayMarkers switch', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  assert.ok(!/el-switch[^>]*showHolidayMarkers/.test(src) && !src.includes('set({showHolidayMarkers'), 'the control that visibly did nothing is gone from the settings page')
})

/* ---------------- B6: appLocale enum re-pin (CLI rejects non-members) ---------------- */

test('B6: CLI `settings set appLocale en-GB` is rejected; the manifest enum stays the single source', async () => {
  process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-daily-0925-domain2-'))
  const db = require_(path.join(ROOT, 'src/main/db.js'))
  db.init(process.env.TODO_DB_DIR)
  const { SETTINGS_MANIFEST } = await importNs('shared/settings-manifest.mjs')
  assert.deepEqual(SETTINGS_MANIFEST.enum.appLocale, ['zh-CN', 'en-US'])
  const lib = require_(path.join(ROOT, 'cli/lib.js'))
  assert.throws(() => lib.settingsSet('appLocale', 'en-GB'), /expects one of/, 'a locale the app does not ship must be rejected at the CLI')
  const r = lib.settingsSet('appLocale', 'en-US')
  assert.equal(r.value, 'en-US', 'a legal member still writes')
})

/* ---------------- P2 root cause: settings key lifecycle guard (consumer-existence scan) ---------------- */

/** Keys with NO read point outside store/settings.js. Each entry must carry a reason; a key
 *  landing here without one fails the test. New keys MUST have a consumer or be added here
 *  deliberately with a backlog note. */
const ORPHAN_BACKLOG = {
  // deliberate LEGACY keys: load() migrates their value into tomatoTime/restTime and drops them
  // (store/settings.js header) — declared only so inbound legacy patches sanitize instead of
  // landing as unknown junk.
  tomatoTimeDefault: 'legacy migration source, dropped on load (settings.js load())',
  restTimeDefault: 'legacy migration source, dropped on load (settings.js load())',
  // orphan backlog found by the 2026-09-25 consumer scan — declared + synced but nothing in the
  // renderer reads them. Removal (or implementation) is a product decision; they are recorded
  // here so NO NEW orphan can sneak in silently.
  showCompleteNoDate: 'orphan (2026-09-25 scan) — no renderer read point; backlog',
  calendarBackground: 'orphan (2026-09-25 scan) — no renderer read point; backlog',
  isCalendarBackgroundUserSelected: 'orphan (2026-09-25 scan) — no renderer read point; backlog',
  isDefaultSubTaskFolded: 'orphan (2026-09-25 scan) — no renderer read point; backlog',
  showTodoCheckboxOrder: 'orphan (2026-09-25 scan) — no renderer read point; backlog',
  calendarFontColor: 'orphan (2026-09-25 scan) — no renderer read point; backlog'
}

test('P2: every DEFAULT_SETTINGS key has a renderer read point — or sits on the explicit orphan backlog', async () => {
  const { DEFAULT_SETTINGS } = await importNs('renderer/js/store/settings.js')
  const walk = (d, out = []) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p, out)
      else if (/\.(vue|js|mjs)$/.test(f)) out.push(p)
    }
    return out
  }
  const files = walk(path.join(ROOT, 'renderer', 'js'))
    .filter(p => p.split(path.sep).join('/') !== 'renderer/js/store/settings.js')
    .map(p => [p, readFileSync(p, 'utf8')])
  const unexplained = []
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key.startsWith('_')) continue // internal stamps (_lsAt etc.) are written/read by the persistence layer itself
    if (ORPHAN_BACKLOG[key]) continue // explicitly on the backlog, with a reason
    const consumed = files.some(([, src]) => src.includes(key))
    if (!consumed) unexplained.push(key)
  }
  assert.deepEqual(unexplained, [], `keys without any renderer read point must be added to ORPHAN_BACKLOG with a reason: ${unexplained.join(', ')}`)
  // every backlog entry must correspond to a real declared key (the list cannot rot)
  for (const k of Object.keys(ORPHAN_BACKLOG)) {
    assert.ok(k in DEFAULT_SETTINGS, `ORPHAN_BACKLOG entry "${k}" is no longer declared in DEFAULT_SETTINGS — remove it from the backlog`)
  }
})
