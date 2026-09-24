/**
 * dw-wave6 backup-pipeline domain (F3) — writeEventBackupCore failure honesty.
 * Regression for: the event snapshot (pre-purge / pre-purge-all) swallowed every failure — the
 * main process signals failure via the return value ({ok:false,error}, handlers/backup.js:97-98),
 * nothing throws, so the bare catch left purge/purge-all hard-deleting with NO evt-*.json on disk
 * and the caller had no idea.
 * Fix contract: writeEventBackupCore checks r.ok, returns a boolean, and stamps failures into
 * runtimeState (eventBackupLastFailAt/eventBackupLastError) — the same honest-status pattern as
 * writeAutoBackupCore; SettingsDataTab's lastBackupFailPrefix channel can render the two keys.
 * Also pins the F7/F17 dump shape: user/lastLoginRecord/tomatoState are no longer written.
 * Run: node --test tests/unit/renderer/dw6-backup-pipeline.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

const LS = new Map()
function resetLs () {
  LS.clear()
  globalThis.localStorage = {
    getItem: k => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, String(v)),
    removeItem: k => LS.delete(k)
  }
}

const baseCtx = () => ({ state: {}, rootState: { settings: {}, category: { list: [] }, habits: { habits: [], moments: [] }, tomato: null, filters: { list: [] } } })

test('F3: writeEventBackupCore returns false and stamps runtimeState when the IPC answers {ok:false}', async () => {
  const { writeEventBackupCore } = await importSrc('renderer/js/store/helpers/todoBackup.js')
  const { loadRuntime } = await importSrc('renderer/js/store/helpers/runtimeState.js')
  resetLs()
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    runAutoBackup: async () => ({ ok: false, error: 'EACCES: backup dir not writable' })
  }
  const r = await writeEventBackupCore({}, baseCtx(), 'purge')
  assert.equal(r, false, 'the boolean result reports the failure to purge/purge-all (was: undefined)')
  const rt = loadRuntime()
  assert.ok(rt.eventBackupLastFailAt > 0, 'fail timestamp recorded for the Settings→Data status line')
  assert.ok(String(rt.eventBackupLastError).includes('EACCES'), 'the reason is kept, not swallowed')
})

test('F3: a thrown IPC failure is stamped too, and a later success clears the failure line', async () => {
  const { writeEventBackupCore } = await importSrc('renderer/js/store/helpers/todoBackup.js')
  const { loadRuntime } = await importSrc('renderer/js/store/helpers/runtimeState.js')
  resetLs()
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    runAutoBackup: async () => { throw new Error('app is locked') }
  }
  assert.equal(await writeEventBackupCore({}, baseCtx(), 'purge-all'), false)
  const rt1 = loadRuntime()
  assert.ok(rt1.eventBackupLastFailAt > 0 && String(rt1.eventBackupLastError).includes('locked'))

  globalThis.window.todoAPI.runAutoBackup = async () => ({ ok: true, file: 'evt-purge-x.json' })
  assert.equal(await writeEventBackupCore({}, baseCtx(), 'purge-all'), true, 'success returns true')
  const rt2 = loadRuntime()
  assert.equal(rt2.eventBackupLastFailAt, 0, 'a later success clears the stale failure line')
  assert.equal(rt2.eventBackupLastError, '')
})

test('F7/F17: buildBackupDump no longer writes the dead user/lastLoginRecord/tomatoState segments', async () => {
  const { buildBackupDump } = await importSrc('renderer/js/store/helpers/todoBackup.js')
  resetLs()
  LS.set('tomatoState', '{"todayTomatoCount":3}')
  const dump = buildBackupDump(
    { settings: {}, auth: { user: { name: 'x' }, lastLoginRecord: { t: 1 } }, category: { list: [] }, habits: { habits: [], moments: [] }, tomato: null, filters: { list: [] } },
    { search: '', todoList: [], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: 0, ignoreReminder: {}, todosVersion: '0' }
  )
  const keys = Object.keys(dump.backup)
  for (const dead of ['user', 'lastLoginRecord', 'tomatoState']) {
    assert.ok(!keys.includes(dead), `dead segment "${dead}" is no longer in the dump (F7/F17 stopped writing it)`)
  }
  for (const alive of ['settingsState', 'todoState', 'tomatoRecords', 'categoryState', 'habitsState', 'filterState']) {
    assert.ok(keys.includes(alive), `consumed segment "${alive}" is still written`)
  }
})

test('F3 adversarial round: SettingsDataTab actually renders the event-snapshot failure channel', async () => {
  // The F3 commit message claimed the lastBackupFailPrefix channel would surface the event keys —
  // adversarial review verified NO .vue rendered them. Pin the render (source-level, same pattern
  // as unit-backup-dump-structure's consumer-facing assertions).
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsDataTab.vue'), 'utf8')
  for (const needle of ['eventBackupLastFailAt', 'eventBackupFailSuffix', 'eventBackupLastError']) {
    assert.ok(src.includes(needle), `SettingsDataTab must render the event-snapshot failure channel (${needle})`)
  }
  // the suffix rides the SAME lastBackupFailPrefix i18n channel as the auto-backup failure line
  const tipIdx = src.indexOf('autoBackupStatusLine + eventBackupFailSuffix')
  assert.ok(tipIdx > 0, 'the event failure suffix is composed into the visible status tip')
})
