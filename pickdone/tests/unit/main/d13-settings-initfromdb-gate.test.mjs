/* D13 fix-wave regression test (renderer settings store), fix 15:
 * initFromDb's boot comparison resolved stamps in LS's favor on ties (`<=`) and the write-back
 * stamped a fresh `_savedAt: Date.now()`. That fresh stamp flows into the db-sync-schema bridge
 * as gateTs, where putRow can never skip a past-dated row — a boot after a crash between
 * sync-apply of a settings row and the next renderer persist re-mirrored the stale LS blob with
 * gateTs=now and re-aged/drowned the peer-applied settings_rows.
 *   (a) ties (`db._savedAt === lsAt`) take the DB/restore branch (`<`), whose mirror re-stamps
 *       with the PRIOR db._savedAt;
 *   (b) the write-back branch carries the PRIOR db._savedAt as the mirrored blob's _savedAt —
 *       the bridge gate — so rows newer than the pre-write-back snapshot still win the gate.
 * settings-store unit style (f3-settings-config-consumed: stub bridge + fresh module import).
 * Run: node --test tests/unit/main/d13-settings-initfromdb-gate.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

const LS_MIRROR = new Map()
function resetLs () {
  LS_MIRROR.clear()
  globalThis.localStorage = {
    getItem: k => (LS_MIRROR.has(k) ? LS_MIRROR.get(k) : null),
    setItem: (k, v) => LS_MIRROR.set(k, String(v)),
    removeItem: k => LS_MIRROR.delete(k)
  }
}

const MIRROR_AT_KEY = 'settingsMirrorAt'

/** Boot initFromDb against a stubbed bridge; captures every mirrored db.settingsState blob. */
async function bootWithBlob (blob, state, lsAt) {
  // NOTE: settings.js (imported fresh per test via ?fresh=) instantiates its OWN dbMirror copy,
  // so _timing cannot be shrunk from here — the real 2000ms debounce applies and the test waits
  // it out below.
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const mirrored = []
  resetLs()
  if (lsAt != null) LS_MIRROR.set(MIRROR_AT_KEY, String(lsAt))
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'getMeta') return blob == null ? null : JSON.stringify(blob)
      if (op === 'setMeta' && params[0] === 'db.settingsState') {
        mirrored.push(JSON.parse(params[1]))
        return 'ok'
      }
      return null
    },
    getSettings: () => Promise.resolve(null), // no config.json shortcut seed
    updateSettings: () => Promise.resolve(true)
  }
  const ctx = {
    state,
    commit: (m, p) => { Object.assign(state, p) },
    dispatch: async (a, p) => { Object.assign(state, p); if (a === 'update') await globalThis.window.todoAPI.updateSettings(p) }
  }
  await settings.actions.initFromDb(ctx)
  // [load-budget 2026-10-25] poll the mirror's observable state instead of racing a
  // 2400ms out-wait against the 2000ms debounce (1.2x — under load the debounce fires
  // later than the race budget and the caller saw an empty mirror = false red).
  for (let i = 0; i < 40 && mirrored.length === 0; i++) await new Promise(r => setTimeout(r, 250))
  return mirrored
}

const baseState = settings_ => ({ ...settings_.state, shortcutKeySettings: { ...settings_.state.shortcutKeySettings } })

test('fix 15a: an equal stamp (tie) no longer writes the stale LS blob back — restore branch wins', async () => {
  const { default: settings } = await importSrc('renderer/js/store/settings.js')
  const T0 = Date.now() - 1000
  // blob equals live state → the restore branch is a canonical no-op; the mirrored blob (line
  // "mirrorToDb with _savedAt: db._savedAt") must carry the PRIOR stamp, never a fresh now.
  const mirrored = await bootWithBlob(
    { _savedAt: T0, schemaV: 1, showNoDate: baseState(settings).showNoDate },
    baseState(settings),
    T0) // lsAt === db._savedAt → tie
  assert.ok(mirrored.length >= 1, 'a mirror write happened (restore branch re-stamps the blob)')
  assert.equal(mirrored[mirrored.length - 1]._savedAt, T0,
    'red before the fix: the tie took the write-back branch and stamped _savedAt ≈ now (gateTs=now drowns newer rows)')
})

test('fix 15b: the write-back branch (db older than LS) stamps the LS content\'s own age (r-fix 2026-10-09)', async () => {
  const { default: settings } = await importSrc('renderer/js/store/settings.js')
  const Told = Date.now() - 5000
  const Tls = Date.now() - 1000 // LS is newer → write-back branch runs
  const mirrored = await bootWithBlob(
    { _savedAt: Told, schemaV: 1, showNoDate: baseState(settings).showNoDate },
    baseState(settings),
    Tls)
  assert.ok(mirrored.length >= 1, 'the write-back mirrored the blob')
  // r-fix 2026-10-09: the write-back content IS the LS value, so the stamp must be the LS age —
  // mirroring the PRIOR db._savedAt paired new content with an old stamp and let an intermediate-
  // timestamp peer blob overwrite the just-recovered local settings on the LWW gate.
  assert.equal(mirrored[mirrored.length - 1]._savedAt, Tls,
    'red before the fix: the write-back kept the PRIOR db._savedAt — new content + old stamp = LWW drift')
})

test('fix 15: a boot with NO db mirror stamps the LS age; fresh now only without any LS stamp (r-fix 2026-10-09)', async () => {
  const { default: settings } = await importSrc('renderer/js/store/settings.js')
  const before = Date.now()
  const Tls = before - 1000
  const mirrored = await bootWithBlob(null, baseState(settings), Tls)
  assert.ok(mirrored.length >= 1)
  // r-fix 2026-10-09: with an LS stamp present the write-back stamps the LS content's own age —
  // only a stamp-less LS falls back to now().
  assert.equal(mirrored[mirrored.length - 1]._savedAt, Tls, 'LS age is the honest stamp for LS content')
})
