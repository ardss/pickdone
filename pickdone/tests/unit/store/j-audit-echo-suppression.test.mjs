/* J-audit 2026-10-22 (config-surface journey audit) — settings double-write echo suppression.
 * P2 live-verified with DB forensics (journey J10): the renderer's own debounced db.settingsState
 * mirror (persist 2s + dbMirror 2s) lands in the SAME channel the CLI watcher hot-applies from.
 * A STALE generation (snapshot taken before the second write, DB write landing ~4s after the
 * first) was treated by the watcher as a fresh external change and hot-applied — store, LS, UI
 * AND config.json all bounced back to the first write (专注时长 5→10 bounced to 5 at +4.3s).
 * Fix: mirror blobs are stamped with the origin _savedAt (watcher sends it as a 2nd event arg);
 * the renderer suppresses patches whose origin stamp is covered by its own mirror watermark.
 * Foreign stamps (CLI / LAN peer) stay newer than the watermark and apply — D1 coexistence kept.
 * Run: node --test tests/unit/store/j-audit-echo-suppression.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const here = p => pathToFileURL(path.join(ROOT, p)).href

const settings = (await import(here('renderer/js/store/settings.js'))).default
const dbMirror = await import(here('renderer/js/utils/dbMirror.js'))
const watcherSrc = readFileSync(path.join(ROOT, 'src/main/external-db-watch.js'), 'utf8')

test('isOwnMirrorStamp (re-anchored W8 b9ed3fec): EXACT own-stamp set — a real echo carries the very stamp we mirrored', () => {
  const key = 'db.echoProbe'
  assert.equal(dbMirror.isOwnMirrorStamp(key, 1000), false, 'no watermark yet -> foreign')
  dbMirror.mirrorToDb(key, { _savedAt: 1000, v: 1 })
  assert.equal(dbMirror.isOwnMirrorStamp(key, 1000), true, 'the queued generation is own')
  // W8 2026-10-24: `<=` watermark swallowed older-but-FOREIGN stamps (cross-machine clock skew /
  // CLI write landing before our mirror) — suppression is now exact-match on a retained set of
  // our own recent mirror stamps. A stale-generation echo still suppresses: it carries the very
  // stamp we mirrored when that generation was queued (test 2), not an arbitrary older number.
  assert.equal(dbMirror.isOwnMirrorStamp(key, 999), false, 'older-but-never-mirrored = foreign (clock-skew safety)')
  assert.equal(dbMirror.isOwnMirrorStamp(key, 1001), false, 'a NEWER stamp is foreign (CLI/peer)')
  assert.equal(dbMirror.isOwnMirrorStamp(key, null), false, 'falsy stamp = foreign (callers without origin)')
  dbMirror.mirrorToDb(key, { _savedAt: 2000, v: 2 })
  assert.equal(dbMirror.isOwnMirrorStamp(key, 1000), true, 'previous own generation stays in the retained set')
  assert.equal(dbMirror.isOwnMirrorStamp(key, 2000), true)
  assert.equal(dbMirror.isOwnMirrorStamp(key, 2001), false)
})

function makeCtx () {
  const dispatched = []
  const state = { tomatoTime: 25, developerMode: false, onboardingToursSeen: {} }
  return { dispatched, state, ctx: { state, commit: () => {}, dispatch: (_type, patch) => { dispatched.push(patch) } } }
}

test('updateExternal suppresses a patch whose origin stamp IS one of our mirror stamps (W8 exact-match)', async () => {
  const { dispatched, ctx } = makeCtx()
  const KEY = 'db.settingsState' // updateExternal pins the settings blob key for suppression
  dbMirror.mirrorToDb(KEY, { _savedAt: 5000, tomatoTime: 5 }) // our newest queued generation
  // the echo of THIS generation lands: suppressed (exact stamp)
  await settings.actions.updateExternal(ctx, { tomatoTime: 5 }, 5000)
  // W8: an older-but-never-mirrored stamp is now FOREIGN (it used to be swallowed by `<=` —
  // that was the cross-machine clock-skew vector). It applies.
  await settings.actions.updateExternal(ctx, { tomatoTime: 5 }, 4999)
  assert.equal(dispatched.length, 1, 'never-mirrored older stamp applies (W8)')
  // a genuinely newer external stamp (CLI/peer wrote after us): applies
  await settings.actions.updateExternal(ctx, { tomatoTime: 30 }, 5001)
  assert.equal(dispatched.length, 2, 'foreign newer stamp applies')
  assert.equal(dispatched[1].tomatoTime, 30)
  // no-origin callers (LAN sync / DB restore re-dispatch) are unaffected
  await settings.actions.updateExternal(ctx, { tomatoTime: 35 })
  assert.equal(dispatched.length, 3, 'origin-less patches still apply')
})

test('the real key works end to end: mirror the state, then the watcher echo of it is suppressed', async () => {
  const { dispatched, ctx } = makeCtx()
  dbMirror.mirrorToDb('db.settingsState', { tomatoTime: 10, _savedAt: 777777, schemaV: 1 })
  await settings.actions.updateExternal(ctx, { tomatoTime: 10 }, 777777)
  assert.equal(dispatched.length, 0, 'the echo of our own mirror blob is not hot-applied')
  await settings.actions.updateExternal(ctx, { tomatoTime: 42 }, 777778)
  assert.equal(dispatched.length, 1, 'a later CLI/peer stamp still applies')
})

test('PACKED payload form works: store.dispatch drops a bare 3rd arg, so the origin must ride inside the payload', async () => {
  // The v1 of this fix was inert in the real app for exactly this reason: main.js dispatched
  // (type, patch, origin) and Vuex read the origin as options and dropped it — the direct-call
  // unit test passed while every real echo applied. This pins the packed shape main.js uses.
  const { dispatched, ctx } = makeCtx()
  // stamps must stay monotonic ACROSS tests in this module (lastOwnStamp is a running max)
  dbMirror.mirrorToDb('db.settingsState', { tomatoTime: 5, _savedAt: 9000000, schemaV: 1 })
  await settings.actions.updateExternal(ctx, { patch: { tomatoTime: 5 }, originSavedAt: 9000000 })
  assert.equal(dispatched.length, 0, 'packed own echo (exact stamp) suppressed')
  await settings.actions.updateExternal(ctx, { patch: { tomatoTime: 5 }, originSavedAt: 8999999 })
  assert.equal(dispatched.length, 1, 'packed older-but-never-mirrored stamp applies (W8 clock-skew safety)')
  await settings.actions.updateExternal(ctx, { patch: { tomatoTime: 30 }, originSavedAt: 9000001 })
  assert.equal(dispatched.length, 2, 'packed foreign stamp applies')
  assert.equal(dispatched[1].tomatoTime, 30)
  await settings.actions.updateExternal(ctx, { patch: { tomatoTime: 35 } })
  assert.equal(dispatched.length, 3, 'packed payload without origin applies')
  // legacy direct-call form stays supported for LAN-sync/DB-restore/tests
  await settings.actions.updateExternal(ctx, { tomatoTime: 5 }, 9000000)
  assert.equal(dispatched.length, 3, 'legacy direct-call own echo still suppressed')
})

test('the watcher sends the BLOB stamp as origin, never the folded watermark `at` (v3 regression pin)', () => {
  // v3 root cause: the origin sent was `at` = max(blob._savedAt, settingsRowsMaxUpdated), and rows
  // get re-stamped when our own mirror blob lands (~2s after its snapshot) — so `at` ALWAYS exceeded
  // the renderer's mirror watermark and every own-echo looked foreign (measured live: origin
  // ...6477 vs blob stamp ...4461). The origin must be the blob's own stamp for the renderer's
  // isOwnMirrorStamp comparison to mean anything.
  assert.ok(watcherSrc.includes('const originSavedAt = (doc && doc._savedAt) || 0'), 'origin = doc._savedAt')
  assert.ok(!/send\('external-settings-changed', patch, at\)/.test(watcherSrc), 'the folded watermark must never ride as the origin')
  assert.match(watcherSrc, /send\('external-settings-changed', patch, originSavedAt\)/)
  // keep the compute -> origin -> send order intact so future edits cannot re-fold `at` in
  const idxSend = watcherSrc.indexOf("send('external-settings-changed', patch, originSavedAt)")
  const idxOrigin = watcherSrc.indexOf('const originSavedAt = (doc && doc._savedAt) || 0')
  const idxPatch = watcherSrc.indexOf('computeSettingsPatch(doc, prev)')
  assert.ok(idxPatch > -1 && idxOrigin > idxPatch && idxSend > idxOrigin, 'patch computed, then origin from doc stamp, then send')
})
