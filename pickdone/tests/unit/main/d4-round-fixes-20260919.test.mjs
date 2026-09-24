/**
 * D4 maintenance round (2026-09-19) — main-process fixes 3..14.
 * Covers: windows crash-relaunch quit-flush, meta GC deleted filter, updater tokenized early flush,
 * security-lock locking intent across the rebuild gap, config-store single-flight + tmp cleanup,
 * protocol 416 on shrunken files, shortcut key normalization, meta GC decision extraction,
 * quit-ack expected-sender set, dbRecovery header/retry guard, quick-add ignoreBlur latch,
 * tomato-float load-retry exhaustion destroy, watcher null-baseline arming.
 * Run: node --test tests/unit/main/d4-round-fixes-20260919.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const src = p => path.join(ROOT, 'src/main', p)
const readSrc = p => fs.readFileSync(src(p), 'utf8')
/** Source with comment-only lines stripped — for assertions on CODE shape (comments legitimately
 *  mention old buggy snippets like `readWatchMtime() || 0` when explaining a fix). */
const codeSrc = p => readSrc(p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** Fresh-require a module with an electron stub injected (pattern from main-r5-lock-crash.test.mjs). */
function freshRequireWithElectron (modulePath, electronStub) {
  const Module = require_('module')
  const resolved = require_.resolve(modulePath)
  delete require_.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return origLoad.call(this, request, parent, isMain)
  }
  try { return require_(modulePath) } finally { Module._load = origLoad }
}

/* ---------------- item 12: quit-ack expected-sender set ---------------- */
const { createQuitAckTracker } = require_('../../../src/main/quit-ack.js')

test('d4 quit-ack: an ack from an UNEXPECTED sender can never satisfy allAcked (id-set round)', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([101, 102], token)
  assert.equal(t.allAcked(), false)
  assert.equal(t.ack(token, 999), false, 'sender we never sent to must be rejected')
  assert.equal(t.allAcked(), false, 'the round is NOT satisfied by a foreign ack')
  assert.equal(t.ack(token, 101), true)
  assert.equal(t.allAcked(), false, 'still waiting for 102')
  assert.equal(t.ack(token, 102), true)
  assert.equal(t.allAcked(), true)
})

test('d4 quit-ack: legacy count rounds keep working (back-compat) and stale tokens stay rejected', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(1, token)
  assert.equal(t.ack(token + 1, 1), false, 'stale token rejected')
  assert.equal(t.ack(token, 1), true)
  assert.equal(t.allAcked(), true)
})

test('d4 quit-ack: abandon still works with the id-set round shape', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([7, 8], token)
  t.abandon(7)
  assert.equal(t.ack(token, 8), true)
  assert.equal(t.allAcked(), true)
})

/* ---------------- item 4: meta GC only live rows anchor meta ---------------- */
const { computeMetaGc } = require_('../../../src/main/handlers/shared.js')

test('d4 meta GC: a repeatId held only by a DELETED task no longer anchors its rule (deleted:0 semantics)', () => {
  const metaKeys = ['repeatRule:live', 'repeatRule:dead', 'projectDeadline:p1', 'projectDeadline:p2', 'unrelated']
  const categories = [{ id: 'p2' }]
  // index.js passes getAll({deleted:0}) — the deleted row is ABSENT here by construction
  const liveRows = [
    { taskId: 'a', repeatId: 'live', deleted: 0 },
    { taskId: 'b', repeatId: null, deleted: 0 }
  ]
  const dead = computeMetaGc(metaKeys, categories, liveRows)
  assert.deepEqual(dead.sort(), ['projectDeadline:p1', 'repeatRule:dead'],
    'only the live task keeps its rule; the deleted-only rule is collected')
})

test('d4 meta GC: index.js query uses deleted:0 (source assertion — the actual P1 fix site)', () => {
  const s = readSrc('index.js')
  assert.match(s, /getAll', \{ deleted: 0 \}/, 'getAll must filter deleted:0')
  assert.doesNotMatch(s, /getAll', \{ deleted: null \}/, 'the deleted:null bug must be gone')
})

/* ---------------- item 3: renderer-crash relaunch goes through the quit-flush chain ---------------- */
test('d4 windows: crash-relaunch uses app.relaunch + app.quit, never app.exit(1) (source assertion)', () => {
  const s = codeSrc('windows.js')
  const crashIdx = s.indexOf("render-process-gone")
  const relaunchIdx = s.indexOf('app.relaunch()', crashIdx)
  const quitIdx = s.indexOf('app.quit()', relaunchIdx)
  assert.ok(relaunchIdx > crashIdx, 'crash path calls app.relaunch')
  assert.ok(quitIdx > relaunchIdx, 'app.quit() follows relaunch so before-quit/will-quit flush runs')
  assert.equal(s.indexOf('app.exit(1)'), -1, 'app.exit(1) must not exist anywhere in windows.js (bypasses dbm.close/WAL checkpoint)')
})

/* ---------------- item 11: watcher null baseline arms instead of kicking ---------------- */
test('d4 index: watcher baseline keeps null (disarmed) instead of mapping to 0 (source assertion)', () => {
  const s = codeSrc('index.js')
  assert.doesNotMatch(s, /readWatchMtime\(\) \|\| 0/, 'the null→0 false-external-write mapping is gone')
  assert.match(codeSrc('index.js'), /lastMtime == null\) \{ lastMtime = m/, 'first non-null read only arms the baseline, no kick')
})

/* ---------------- item 10: tomato-float destroys the window when load retries are exhausted ---------------- */
test('d4 tomato-float: retry exhaustion destroys the dead window for lazy recreate (source assertion)', () => {
  const s = readSrc('tomato-float.js')
  const failIdx = s.indexOf("'did-fail-load'")
  const exhaustIdx = s.indexOf('loadRetries < 5', failIdx)
  const destroyIdx = s.indexOf('win.destroy()', exhaustIdx)
  assert.ok(exhaustIdx > failIdx && destroyIdx > exhaustIdx, 'the exhaustion branch calls win.destroy()')
})

/* ---------------- item 14: quick-add ignoreBlur cannot latch ---------------- */
test('d4 quick-add: ignoreBlur is time-boxed and reset on did-finish-load (source assertion)', () => {
  const s = readSrc('quick-add.js')
  assert.match(s, /setTimeout\(\(\) => \{ ignoreBlur = false \}/, 'the latch is time-boxed in toggle()')
  const finishIdx = s.indexOf("'did-finish-load'")
  assert.ok(s.indexOf('ignoreBlur = false', finishIdx) > finishIdx && finishIdx > -1,
    'did-finish-load resets the latch (covers --no-focus summons that never blur)')
})

/* ---------------- item 9: shortcut key normalization ---------------- */
const { normalizeKey } = require_('../../../src/main/shortcuts.js')

test('d4 shortcuts: saved config key variants normalize to the Accelerator vocabulary', () => {
  assert.equal(normalizeKey('del'), 'delete')
  assert.equal(normalizeKey('DEL'), 'delete')
  assert.equal(normalizeKey('ins'), 'insert')
  assert.equal(normalizeKey('esc'), 'escape')
  assert.equal(normalizeKey('delete'), 'delete', 'canonical names pass through')
  assert.equal(normalizeKey('F2'), 'f2')
  assert.equal(normalizeKey(''), '')
  assert.equal(normalizeKey(null), '')
  // and the dead ternary is gone from the before-input-event wiring
  assert.doesNotMatch(codeSrc('shortcuts.js'), /key === 'delete' \? 'delete' : key/)
})

/* ---------------- item 8: protocol 416 when the file shrank to nothing under the range ---------------- */
const { fileResponse } = require_('../../../src/main/protocol.js')

test('d4 protocol: bytesRead===0 (file shrank between stat and read) answers 416, not an invalid 206', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-proto-'))
  const file = path.join(dir, 'sound.ogg')
  fs.writeFileSync(file, Buffer.alloc(2048, 7))
  const origOpen = fs.promises.open
  let calls = 0
  fs.promises.open = async (...a) => {
    calls++
    const fh = await origOpen(...a)
    return {
      read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }), // simulated concurrent truncation
      close: async () => fh.close()
    }
  }
  try {
    const res = await fileResponse(file, 'audio/ogg', { headers: { Range: 'bytes=0-1023' } })
    assert.equal(res.status, 416, 'a zero-byte range read is "range not satisfiable", not a 206 with Content-Range bytes 0--1')
    assert.equal(res.headers.get('content-range') || res.headers['Content-Range'], 'bytes */2048')
  } finally {
    fs.promises.open = origOpen
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(calls, 1, 'the patched read path was exercised')
})

/* ---------------- item 7: config-store single-flight + tmp residue cleanup ---------------- */
test('d4 config-store: concurrent writeConfig calls both land; a throwing write leaves no tmp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-cfg-'))
  const electronStub = { app: { getPath: () => dir } }
  const store = freshRequireWithElectron(src('config-store.js'), electronStub)
  try {
    store.writeConfig({ a: 1 })
    store.writeConfig({ b: 2 })
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    assert.equal(onDisk.a, 1)
    assert.equal(onDisk.b, 2, 'both patches landed (read-modify-write never interleaved)')
    // throwing write: force the tmp creation to fail once; the tmp file must be cleaned before rethrow.
    // 2026-09-22 main-ipc-2: the write goes through writeFileDurable (fd write + fsync before the
    // rename), so the injection point moved from writeFileSync(config.json.tmp) to openSync(tmp).
    // 2026-09-24 C3: tmp names are unique per call — `config.json.<pid>.<ms>.dtmp` — so match on
    // the basename prefix + .dtmp suffix instead of the old fixed constant.
    const origOpen = fs.openSync
    let failed = false
    fs.openSync = function (p, ...rest) {
      const base = String(p).split(/[\\/]/).pop()
      if (base.startsWith('config.json.') && base.endsWith('.dtmp')) { failed = true; throw new Error('EACCES: disk full') }
      return origOpen.call(this, p, ...rest)
    }
    try {
      assert.throws(() => store.writeConfig({ c: 3 }), /disk full/)
    } finally {
      fs.openSync = origOpen
    }
    assert.ok(failed, 'the failure was injected at the tmp write')
    assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.dtmp')).length, 0, 'no tmp residue after a failed write')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).b, 2, 'previous good config still intact')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- item 6: security-lock isLocked stays true across the rebuild gap ---------------- */
test('d4 security-lock: locking intent holds isLocked() true during the 300ms rebuild gap', async () => {
  const calls = { writes: [] }
  let lockWinInstance = null
  const fakeWC = () => {
    const handlers = {}
    return {
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      once: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      send: () => {},
      emit: (ev, ...a) => { for (const fn of handlers[ev] || []) fn(...a) },
      setWindowOpenHandler: () => ({ action: 'deny' })
    }
  }
  const electronStub = {
    BrowserWindow: class {
      constructor () { this.webContents = fakeWC(); this.destroyed = false; lockWinInstance = this }
      isDestroyed () { return this.destroyed }
      focus () {}
      loadURL () { return Promise.resolve() }
      on () {}
      destroy () { this.destroyed = true }
    }
  }
  const lock = freshRequireWithElectron(src('security-lock.js'), electronStub).createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => ({ enableSecurityLock: true, securityLockPassword: '' }),
    writeConfig: p => calls.writes.push(p),
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} }
  })
  lock.lockAppNow()
  assert.equal(lock.isLocked(), true)
  // Crash: the self-heal destroys the window and rebuilds 300ms later. During that gap the old
  // isLocked() (window-liveness only) returned false and opened every shortcut/IPC gate.
  lockWinInstance.webContents.emit('render-process-gone', null, { reason: 'crashed', exitCode: 1 })
  assert.equal(lock.isLocked(), true, 'intent keeps the app locked in the rebuild gap (window is null right now)')
  await new Promise(r => setTimeout(r, 400))
  assert.equal(lock.isLocked(), true, 'rebuilt lock window keeps the app locked')
  lock.unlockAppNow()
  assert.equal(lock.isLocked(), false, 'unlock clears the intent')
})

/* ---------------- item 13: dbRecovery never renames a header-healthy DB ---------------- */
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')

function makeUd () {
  // Nested under a fresh parent: criticalBackupPath looks at dirname(ud)/pickdone-backups, so ud
  // itself must not sit directly in os.tmpdir() where stale pickdone-backups could accumulate.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-rec-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.concat([Buffer.from('SQLite format 3\x00', 'binary'), Buffer.alloc(4096 - 16, 1)]))
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'stale backup')
  return ud
}

test('d4 dbRecovery: healthy header + transient init failure (retry fails) → NO rename, DB preserved', () => {
  const ud = makeUd()
  try {
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('EBUSY: lock held') })
    assert.equal(r.source, 'transient')
    assert.equal(fs.existsSync(path.join(ud, 'todos.db')), true, 'todos.db untouched')
    assert.equal(fs.readFileSync(path.join(ud, 'todos.db'), 'utf8').slice(0, 15), 'SQLite format 3')
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 0, 'no .corrupt scene created')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('d4 dbRecovery: healthy header + retry succeeds → retry-ok, no recovery performed', () => {
  const ud = makeUd()
  try {
    let retries = 0
    const r = dbRecovery.attemptDbRecovery(ud, () => { retries++ })
    assert.equal(retries, 1, 'exactly one retry before giving the file up as healthy')
    assert.equal(r.source, 'retry-ok')
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 0)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('d4 dbRecovery: a WRONG header (real corruption) still enters the rename recovery path', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-rec2-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud) // nested: keep criticalBackupPath's dirname(ud)/pickdone-backups lookup isolated
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.alloc(4096, 0)) // garbage header
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'backup')
  try {
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('still broken') })
    assert.equal(r.source, 'plain-bak', 'genuinely corrupt DB recovers from the plaintext backup')
    assert.ok(fs.readdirSync(ud).some(f => f.startsWith('todos.db.corrupt-')), 'corrupt file preserved as .corrupt-*')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('d4 dbRecovery: index.js passes the retry hook (source assertion)', () => {
  assert.match(readSrc('index.js'), /attemptDbRecovery\(ud, \(\) => dbm\.init\(ud\)\)/)
})

/* ---------------- item 5: updater early flush uses the tokenized handshake ---------------- */
// electron-updater touches electron.app.getVersion at require time — stub enough for module load.
const ELECTRON_UPDATER_STUB = { app: { getVersion: () => '0.0.0' } }

test('d4 updater: flushOnceOnReady sends a token, acks route via forwardFlushAck, flush after acks', async () => {
  const { flushOnceOnReady, forwardFlushAck } = freshRequireWithElectron(src('updater.js'), ELECTRON_UPDATER_STUB)
  const sent = []
  const mkWin = id => ({ webContents: { id, send: (ch, payload) => sent.push({ id, ch, payload }) }, isDestroyed: () => false })
  const windows = [mkWin(11), mkWin(12)]
  const flushed = []
  flushOnceOnReady({
    getWindows: () => windows,
    flushMain: () => flushed.push('flush'),
    ACK_CAP_MS: 3000
  })
  assert.equal(sent.length, 2, 'both live windows got the flush broadcast')
  const token = sent[0].payload && sent[0].payload.token
  assert.ok(token, 'the broadcast carries a quit-ack token (was: tokenless)')
  await new Promise(r => setTimeout(r, 200))
  assert.equal(flushed.length, 0, 'no acks yet → main flush not performed early')
  assert.equal(forwardFlushAck(token, 11), true, 'ack from an expected sender routes into the round')
  assert.equal(forwardFlushAck(token, 99), false, 'ack from an unexpected sender is rejected')
  assert.equal(forwardFlushAck(token, 12), true, 'second expected sender acks')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(flushed.length, 1, 'all expected acks in → the main-process flush runs before any taskkill')
})

test('d4 updater: flushOnceOnReady is bounded — no acks still flushes at the cap (taskkill race bound)', async () => {
  const { flushOnceOnReady } = freshRequireWithElectron(src('updater.js'), ELECTRON_UPDATER_STUB)
  const flushed = []
  flushOnceOnReady({ getWindows: () => [], flushMain: () => flushed.push('f'), ACK_CAP_MS: 120 })
  await new Promise(r => setTimeout(r, 400))
  assert.equal(flushed.length, 1, 'the cap path always performs the main-process flush')
})

test('d4 updater: flushOnceOnReady fires once per process (idempotent)', async () => {
  const mod = freshRequireWithElectron(src('updater.js'), ELECTRON_UPDATER_STUB)
  const flushed = []
  mod.flushOnceOnReady({ getWindows: () => [], flushMain: () => flushed.push('f'), ACK_CAP_MS: 50 })
  mod.flushOnceOnReady({ getWindows: () => [], flushMain: () => flushed.push('f'), ACK_CAP_MS: 50 })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(flushed.length, 1)
})
