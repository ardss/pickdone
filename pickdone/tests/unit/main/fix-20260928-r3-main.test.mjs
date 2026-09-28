/**
 * r3 main-domain fixes (2026-09-28), five regressions:
 *  1. db-oplog appendOplog: an INSERT failure is no longer log-only — the delta pointer is the
 *     ONLY record increment propagation has, so the loss is counted (oplogStats) and surfaced
 *     through the injected onAppendFailure hook (db.js wires it to an 'oplog-append-failed'
 *     syncEvent via lan-sync-bootstrap.emitOplogAppendFailure).
 *  2. The one-way-loss sync events have renderer consumers: SettingsSyncTab.vue branches on
 *     'egress-hydration-failed' AND 'oplog-append-failed', and the syncEvent type enum doc in
 *     lan-sync-bootstrap lists them.
 *  3. isMachineLocalMetaKey + META_CONFLICT_BACKUP_PREFIX are SINGLE-SOURCED in
 *     shared/machine-local-keys.mjs — command-manifest.js and sync-apply-hydrate.js now import
 *     the SAME function object (the manifest's hand-copied 9-family mirror is gone).
 *  4. Six dead IPC channels are deleted on all three ends (preload facade / main handler /
 *     browser shim): decryptSecret, hideWindow, downloadAndOpen, saveToDownloads, syncNow,
 *     mimeByType — including the unused-but-reachable decrypt-secret door to lock ciphertext.
 *  5. scheduler.loadFiredFromMeta: a corrupt watermark timestamp is DROPPED (catch-up may
 *     re-fire) instead of being faked to Date.now() (which silently swallowed the reminder
 *     forever); the outer catch logs instead of staying silent.
 * Run: node --test tests/unit/main/fix-20260928-r3-main.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const oplogFactory = require('../../../src/main/db-oplog.js')
const manifest = require('../../../src/main/command-manifest.js')
const hydrate = require('../../../src/main/sync-apply-hydrate.js')
const boot = require('../../../src/main/lan-sync-bootstrap.js').__test
const bootRoot = require('../../../src/main/lan-sync-bootstrap.js')
const scheduler = require('../../../src/main/scheduler.js')
const sharedKeys = require('../../../shared/machine-local-keys.mjs')

/* ---------- 1. oplog append failure is counted + surfaced ---------- */

function failingDb () {
  const calls = []
  return {
    calls,
    prepare (sql) {
      if (/INSERT INTO sync_oplog/.test(sql)) {
        return { run: (...a) => { calls.push(a); throw new Error('disk I/O error (mocked)') } }
      }
      return { get: () => ({ n: 0 }) }
    },
    transaction (fn) { return fn },
  }
}

test('r3-1: a failed oplog INSERT increments oplogStats and fires the onAppendFailure hook', () => {
  const failures = []
  const db = failingDb()
  const mod = oplogFactory({
    getDb: () => db,
    log: { warn () {}, info () {}, error () {} },
    onAppendFailure: info => failures.push(info),
  })
  const before = mod.oplogStats().appendFailures
  mod.appendOplog([{ entity: 'todo', entityId: 't1', ts: 123 }])
  assert.equal(failures.length, 1, 'the hook must fire exactly once for the failed append')
  assert.equal(failures[0].count, before + 1, 'the failure counter is monotonic and handed to the hook')
  assert.match(failures[0].error, /disk I\/O error/)
  assert.equal(mod.oplogStats().appendFailures, before + 1, 'oplogStats exposes the same counter')
  assert.equal(db.calls.length, 1, 'the INSERT was attempted (row NOT silently skipped)')
})

test('r3-1: a healthy append still works and fires nothing', () => {
  const rows = []
  const failures = []
  const mod = oplogFactory({
    getDb: () => ({
      prepare (sql) {
        if (/INSERT INTO sync_oplog/.test(sql)) return { run: (...a) => rows.push(a) }
        return { get: () => ({ n: 0 }) }
      },
      transaction (fn) { return fn },
    }),
    log: { warn () {}, info () {}, error () {} },
    onAppendFailure: () => failures.push(1),
  })
  mod.appendOplog([{ entity: 'todo', entityId: 't1', ts: 5 }, { entity: 'meta', entityId: 'projectX', ts: 6 }])
  assert.equal(rows.length, 2, 'both entries inserted')
  assert.deepEqual(failures, [], 'no failure signal on the happy path')
})

test('r3-1: db.js wires onAppendFailure to the bootstrap emitter (lazy, throw-safe)', () => {
  const src = read('src/main/db.js')
  assert.match(src, /onAppendFailure:\s*info => \{\s*try \{ require\('\.\/lan-sync-bootstrap'\)\.emitOplogAppendFailure\(info\) \} catch/,
    'db.js must route the oplog failure hook into the sync-event channel')
  // the exported emitter is throw-safe with no live state (sync never initialized)
  assert.doesNotThrow(() => bootRoot.emitOplogAppendFailure({ count: 1, error: 'x' }))
})

test('r3-2: emitOplogAppendFailure broadcasts an oplog-append-failed syncEvent to window senders', () => {
  const sent = []
  boot.setState({ getWindowSenders: () => [{ isDestroyed: () => false, send: (ch, msg) => sent.push({ ch, msg }) }] })
  try {
    bootRoot.emitOplogAppendFailure({ count: 3, error: 'boom' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].ch, 'syncEvent')
    assert.equal(sent[0].msg.type, 'oplog-append-failed')
    assert.equal(sent[0].msg.count, 3)
    assert.equal(sent[0].msg.error, 'boom')
  } finally { boot.setState(null) }
})

/* ---------- 2. renderer consumers + enum doc ---------- */

test('r3-2: SettingsSyncTab.vue consumes egress-hydration-failed AND oplog-append-failed', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue')
  assert.match(src, /evt\.type === 'egress-hydration-failed'/, 'the egress loss event must have a renderer branch')
  assert.match(src, /evt\.type === 'oplog-append-failed'/, 'the oplog loss event must have a renderer branch')
  const bootSrc = read('src/main/lan-sync-bootstrap.js')
  const typesDoc = bootSrc.slice(bootSrc.indexOf('Types:'), bootSrc.indexOf('function emitSyncEvent'))
  assert.ok(typesDoc.includes('egress-hydration-failed'), 'syncEvent enum doc lists egress-hydration-failed')
  assert.ok(typesDoc.includes('oplog-append-failed'), 'syncEvent enum doc lists oplog-append-failed')
  for (const key of ['egressHydrationFailed', 'oplogAppendFailed']) {
    assert.ok(read('renderer/js/i18n/en-US.js').includes(key) && read('renderer/js/i18n/zh-CN.js').includes(key),
      key + ' i18n key exists in both locales')
  }
})

/* ---------- 3. single-sourced machine-local meta predicate ---------- */

test('r3-3: command-manifest and sync-apply-hydrate share ONE isMachineLocalMetaKey function', () => {
  assert.equal(manifest.isMachineLocalMetaKey, hydrate.isMachineLocalMetaKey,
    'both ends must import the same function object from shared/machine-local-keys.mjs')
  assert.equal(manifest.isMachineLocalMetaKey, sharedKeys.isMachineLocalMetaKey)
  assert.equal(hydrate.META_CONFLICT_BACKUP_PREFIX, 'metaConflictBackup.')
  // spot-check the family corpus: all previously-mirrored families still classify identically
  for (const k of ['sync.pushCursor', '_lsAt', 'securityLockPwd', 'cliTomatoCmd', 'cliSyncCmd',
    'todosVersion', 'firedReminders:abc', 'reminderLastSeenAt', 'settingsRows.src.v6',
    'db.tomatoState', 'habitsState', 'snowDedup:t:1', 'metaConflictBackup.meta:1.abc',
    'schemaVersion', 'dayPlanState', 'dayPlanState.bak']) {
    assert.equal(sharedKeys.isMachineLocalMetaKey(k), true, k + ' stays machine-local')
  }
  for (const k of ['projectMilestones:a', 'repeatRule:1', 'userKey']) {
    assert.equal(sharedKeys.isMachineLocalMetaKey(k), false, k + ' stays user data (syncs)')
  }
  // the hand copy is really gone from command-manifest.js
  const src = read('src/main/command-manifest.js')
  assert.doesNotMatch(src, /const isMachineLocalMetaKey = k => \{/, 'no hand-copied predicate body remains')
})

/* ---------- 4. dead IPC channels deleted on all three ends ---------- */

const DEAD_FACADE = ['decryptSecret', 'hideWindow', 'downloadAndOpen', 'saveToDownloads', 'syncNow', 'mimeByType']

test('r3-4: the 6 dead todoAPI methods are gone from preload, the shim, and contracts', () => {
  const preload = read('src/preload/index.js')
  const shim = read('browser-dev/todo-browser-shim.js')
  const contracts = read('renderer/js/contracts.d.ts')
  for (const k of DEAD_FACADE) {
    assert.doesNotMatch(preload, new RegExp('^  ' + k + ':', 'm'), 'preload facade: ' + k + ' removed')
    assert.ok(!shim.includes(k + ':'), 'browser shim: ' + k + ' stub removed')
    assert.ok(!contracts.includes(k), 'contracts.d.ts: ' + k + ' member removed')
  }
  // and the renderer never called them (the premise of the removal)
  for (const k of DEAD_FACADE) {
    const uses = []
    const walk = d => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (/\.(js|vue)$/.test(f.name) && !f.name.includes('shim')) {
          const s = fs.readFileSync(p, 'utf8')
          if (new RegExp('todoAPI\\.' + k + '\\b').test(s)) uses.push(p)
        }
      }
    }
    walk(path.join(ROOT, 'renderer', 'js'))
    assert.deepEqual(uses, [], 'renderer must have zero todoAPI.' + k + ' calls')
  }
})

test('r3-4: the 6 dead IPC channels are unregistered in the main handlers', () => {
  const files = {
    'decrypt-secret': 'src/main/handlers/security.js',
    'hide-main-window': 'src/main/handlers/tomato.js',
    'download-file-and-open': 'src/main/handlers/attachments.js',
    'save-upload-file-to-download': 'src/main/handlers/attachments.js',
    'sync-todos-to-server': 'src/main/handlers/system.js',
    'mime-get-type': 'src/main/handlers/attachments.js',
  }
  for (const [ch, rel] of Object.entries(files)) {
    const src = read(rel)
    assert.ok(!src.includes("'" + ch + "':"), rel + ' no longer registers ' + ch)
  }
})

/* ---------- 5. scheduler corrupt watermark handling ---------- */

test('r3-5: a corrupt fired-reminder timestamp is DROPPED, not faked to Date.now()', () => {
  scheduler._clearStateForTest()
  const before = Date.now()
  const db = { call: (op, p) => op === 'getMeta' ? ['good|' + (before - 60000), 'bad|notanumber', 'zero|0', 'neg|-5', 'broken'].join('\x1f') : null }
  scheduler.loadFiredFromMeta(db)
  assert.equal(scheduler._fired.has('good'), true, 'a well-formed entry still restores')
  assert.equal(scheduler._fired.get('good').ts, before - 60000)
  for (const k of ['bad', 'zero', 'neg', 'broken']) {
    const v = scheduler._fired.get(k)
    assert.ok(v === undefined || v.ts <= before - 60000,
      'corrupt entry ' + k + ' must NOT become a fresh "just fired" watermark')
  }
  assert.equal(scheduler._fired.has('bad'), false, 'non-numeric ts dropped (catch-up may re-fire)')
  assert.equal(scheduler._fired.has('zero'), false, 'ts=0 dropped')
  assert.equal(scheduler._fired.has('neg'), false, 'negative ts dropped')
  assert.equal(scheduler._fired.has('broken'), false, 'entry without | dropped')
  scheduler._clearStateForTest()
})

test('r3-5: a throwing getMeta is logged, not silently swallowed', () => {
  const warns = []
  const origWarn = console.warn
  // scheduler's log is electron-log (or its fallback); intercept whatever reaches console via
  // the module-level `log` — in bare node electron-log resolves to the npm shim writing via
  // console. Assert the call does not throw; the warn surface is exercised by the source check.
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    assert.doesNotThrow(() => scheduler.loadFiredFromMeta({ call: () => { throw new Error('db closed') } }))
  } finally { console.warn = origWarn }
  const src = read('src/main/scheduler.js')
  assert.match(src, /fired-reminder watermark load failed/, 'the outer catch logs a warning line')
})
