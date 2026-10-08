// Fix-round d23 (2026-10-06) LAN-sync failsafe batch:
//   - att-transfer writeAtomic: a failed setAlias after a conflict rename must FAIL the write
//     (no phantom success / permanent re-pull loop)
//   - att-transfer attachDir: no process.cwd() fallback — failure is rethrown (fail closed)
//   - lan-sync index pickEvictPeerId: two-stage eviction covers diverged peers/lastSeenBy maps
//   - external-db-watch: corrupt db.settingsState at boot -> first successful parse absorbs a
//     baseline (no hot-apply push); the next real change pushes
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const att = require('../../../src/main/lan-sync/att-transfer.js')
const { pickEvictPeerId } = require('../../../src/main/lan-sync/index.js')
const { createExternalDbWatch } = require('../../../src/main/external-db-watch.js')

// ---------- writeAtomic: alias failure after conflict rename fails the write ----------

function makeTmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'att-d23-')) }

test('writeAtomic: setAlias failure after a conflict rename throws (no phantom success)', () => {
  const dir = makeTmp()
  try {
    let aliasCalls = 0
    const attachmentsMod = {
      attachDir: () => dir,
      readAliases: () => ({}),
      setAlias: () => { aliasCalls++; throw new Error('alias map unwritable') },
    }
    const d = att.makeDeps({ attachmentsMod })
    // Pre-existing file under the same basename with DIFFERENT content -> conflict rename path
    fs.writeFileSync(path.join(dir, 'doc.png'), Buffer.from('original-bytes'))
    assert.throws(
      () => d.writeAtomic('doc.png', Buffer.from('incoming-different-bytes')),
      e => /alias registration failed/.test(e.message)
    )
    assert.equal(aliasCalls, 1)
    // The renamed conflict file stays on disk (forensics), nothing claims phantom success
    assert.ok(fs.existsSync(path.join(dir, 'doc-1.png')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('writeAtomic: successful setAlias after conflict rename still returns the final basename', () => {
  const dir = makeTmp()
  try {
    const aliases = new Map()
    const attachmentsMod = {
      attachDir: () => dir,
      readAliases: () => Object.fromEntries(aliases),
      setAlias: (from, to) => { aliases.set(from, to) },
    }
    const d = att.makeDeps({ attachmentsMod })
    fs.writeFileSync(path.join(dir, 'doc.png'), Buffer.from('original-bytes'))
    const finalName = d.writeAtomic('doc.png', Buffer.from('incoming-different-bytes'))
    assert.equal(finalName, 'doc-1.png')
    assert.equal(aliases.get('doc.png'), 'doc-1.png')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- attachDir: no cwd fallback (fail closed) ----------

test('attachDir failure rethrows and never caches process.cwd()', () => {
  const attachmentsMod = {
    attachDir: () => { throw new Error('userData unavailable') },
    readAliases: () => ({}),
    setAlias: () => {},
  }
  const d = att.makeDeps({ attachmentsMod })
  // writeAtomic must throw instead of silently landing the file in process.cwd()
  assert.throws(() => d.writeAtomic('doc.png', Buffer.from('x')), /userData unavailable/)
  // Repeated calls keep failing (no cached cwd directory)
  assert.throws(() => d.writeAtomic('doc.png', Buffer.from('x')), /userData unavailable/)
  // And nothing was written into process.cwd()
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'doc.png')))
})

// ---------- peer LRU eviction with diverged maps ----------

test('pickEvictPeerId: LRU pick normally, first-peer fallback when maps diverge', () => {
  const peers = new Map([['p1', {}], ['p2', {}], ['p3', {}]])
  const lastSeenBy = new Map([['p1', 100], ['p2', 300], ['p3', 200]])
  assert.equal(pickEvictPeerId(peers, lastSeenBy, 'incoming'), 'p1') // oldest seen
  // Diverged: peers has entries, lastSeenBy is empty -> fallback picks the first peer key
  const emptySeen = new Map()
  assert.equal(pickEvictPeerId(peers, emptySeen, 'incoming'), 'p1')
  // Never the incoming peer itself
  assert.equal(pickEvictPeerId(new Map([['incoming', {}]]), emptySeen, 'incoming'), null)
  // Fully bounded end-to-end: 65 addPeer calls keep the node at 64 peers even when the
  // lastSeenBy twin of an early entry disappears (divergence) — via a real node instance.
  const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
  const node = createLanSyncNode({
    deviceId: 'self',
    name: 'Self',
    pairingSecret: 's',
    port: 0,
    host: '127.0.0.1',
    discoverFn: { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] },
    ingestSegment: () => {},
    ingestSnapshot: () => {},
  })
  try {
    node.start()
    for (let i = 0; i < 70; i++) node.addPeer({ deviceId: 'peer-' + i, host: '10.0.0.' + (i % 250 + 1), port: 1 })
    assert.equal(node.getStatus().peers.length, 64)
  } finally { node.stop() }
})

// ---------- external-db-watch: corrupt boot seed -> baseline absorption, no spurious push ----------

test('external-db-watch: corrupt settingsState blob at boot does not hot-apply on first valid read', () => {
  const sent = []
  const win = { isDestroyed: () => false, webContents: { send: (ch, patch) => sent.push({ ch, patch }) } }
  let blob = 'THIS-IS-NOT-JSON'
  const maxRow = 400
  const dbm = {
    call: (op, k) => {
      if (op === 'getMeta') {
        if (k === 'db.settingsState') return blob
        return null // cliTomatoSeq / cliTomatoCmd
      }
      if (op === 'settingsRowsMaxUpdated') return maxRow
      return null
    },
  }
  const w = createExternalDbWatch({
    app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'extwatch-d23-')) },
    log: { info () {}, warn () {}, error () {} },
    dbm,
    fixUtil: { stableRead: fn => fn(), tryForwardTomatoCmd: () => ({ lastTomatoCmdRaw: null, lastTomatoSeq: 0, sent: false }) },
    extWatchGate: { canPoll: () => true },
    nextWatchBaseline: (prev, read) => read() ?? prev,
    scheduler: { reloadAll () {} },
    getMainWindow: () => win,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged () {},
    broadcastTomatoRecordsChanged () {},
    BrowserWindow: { getAllWindows: () => [win] },
  })
  try {
    w.watchDbForExternalWrites()
    // Tick 1: blob becomes parseable, _savedAt (500) > seeded row watermark (400) — the
    // pre-boot baseline contract absorbs it WITHOUT pushing (old code pushed a full diff
    // against a 0/null baseline or missed it silently).
    blob = JSON.stringify({ _savedAt: 500, language: 'en' })
    w.__pollTickForTests()
    assert.equal(sent.filter(s => s.ch === 'external-settings-changed').length, 0, 'first valid read is baseline-only')
    // Tick 2: a REAL change (field flip + _savedAt bump) pushes exactly the delta.
    blob = JSON.stringify({ _savedAt: 600, language: 'zh' })
    w.__pollTickForTests()
    const pushes = sent.filter(s => s.ch === 'external-settings-changed')
    assert.equal(pushes.length, 1, 'subsequent real change pushes once')
    assert.deepEqual(pushes[0].patch, { language: 'zh' })
  } finally { w.stopForQuit() }
})
