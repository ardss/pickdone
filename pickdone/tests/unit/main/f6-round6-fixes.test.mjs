import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { stableRead, nextFreePath } = require('../../../src/main/fix-util.js')
const { createQuitAckTracker } = require('../../../src/main/quit-ack.js')
const { toSoundUrl } = require('../../../src/main/notify-sound.js')

/* ---- stableRead (P2: readWatchMtime torn read between db and -wal statSync calls) ---- */
test('stableRead: returns the value once two consecutive reads agree', () => {
  let n = 0
  const seq = [10, 10] // first sample torn, second matches → 10
  assert.equal(stableRead(() => seq[Math.min(n++, 1)]), 10)
})
test('stableRead: converges on a changing value (CLI finished writing mid-sample)', () => {
  const seq = [1, 2, 3, 3, 3]
  let i = 0
  assert.equal(stableRead(() => seq[Math.min(i++, seq.length - 1)]), 3)
})
test('stableRead: persistent change yields null so the caller skips this sample', () => {
  let i = 0
  assert.equal(stableRead(() => i++), null)
})
test('stableRead: read throwing maps to null (file gone mid-poll)', () => {
  assert.equal(stableRead(() => { throw new Error('boom') }), null)
})

/* ---- nextFreePath (P2: saveAttachment same-millisecond same-name silent overwrite) ---- */
test('nextFreePath: free name passes through untouched', () => {
  assert.equal(nextFreePath('D:\\att', 't1_5_a.png', () => false).replace(/\\/g, '/'), 'D:/att/t1_5_a.png')
})
test('nextFreePath: existing name gets -1, then -2 suffixes before the extension', () => {
  const taken = new Set(['D:/att/a.png', 'D:/att/a-1.png'])
  assert.equal(nextFreePath('D:\\att', 'a.png', p => taken.has(p.replace(/\\/g, '/'))).replace(/\\/g, '/'), 'D:/att/a-2.png')
})

/* ---- quit-ack nextToken (P2: Date.now() token collision within the same millisecond) ---- */
test('nextToken: strictly increasing even when Date.now() stands still', () => {
  const q = createQuitAckTracker()
  const t1 = q.nextToken()
  const t2 = q.nextToken() // same millisecond in real runs
  assert.ok(t2 > t1, 'token must strictly increase')
})
test('nextToken: stays monotonic when the clock jumps back or a round already used a token', () => {
  const q = createQuitAckTracker()
  const t1 = q.nextToken()
  q.beginRound(2, t1)
  const t2 = q.nextToken()
  assert.ok(t2 > t1)
})
test('ack: stale-token guard still works with generated tokens', () => {
  const q = createQuitAckTracker()
  const t1 = q.nextToken()
  const t2 = q.nextToken()
  q.beginRound(1, t2)
  assert.equal(q.ack(t1, 7), false, 'older token must not satisfy this round')
  assert.equal(q.ack(t2, 7), true)
})

/* ---- toSoundUrl (P1: cross-drive path.relative returns an absolute path → malformed app:// URL;
        '..' escape fell back to a raw Windows path the renderer cannot play) ---- */
const WIN = process.platform === 'win32'
test('toSoundUrl: file inside appRoot keeps the app:// mapping', () => {
  const root = WIN ? 'K:\\app\\pickdone' : '/app/pickdone'
  const file = WIN ? 'K:\\app\\pickdone\\assets\\media\\a.ogg' : '/app/pickdone/assets/media/a.ogg'
  assert.equal(toSoundUrl(file, root), 'app://app/assets/media/a.ogg')
})
test('toSoundUrl: file outside appRoot (.. escape) becomes a playable file:// URL, not a raw path', () => {
  const root = WIN ? 'K:\\app\\pickdone' : '/app/pickdone'
  const file = WIN ? 'K:\\app\\other\\a.wav' : '/app/other/a.wav'
  const url = toSoundUrl(file, root)
  assert.ok(/^file:\/\/\//.test(url), 'file:// URL: ' + url)
  assert.ok(url.includes('other/a.wav'))
})
;(WIN ? test : test.skip)('toSoundUrl: cross-drive relative (absolute result, no .. prefix) becomes file:// not app://', () => {
  const url = toSoundUrl('C:\\Users\\x\\n.mp3', 'K:\\app\\pickdone')
  assert.ok(url.startsWith('file:///C:'), 'malformed app://app/C:/... must never be produced: ' + url)
})

/* ---- tomato-taskbar buttonsSet stale flag (P1: toolbar lost forever after window recreation) ---- */
test('taskbar: init resets buttonsSet so a recreated window re-arms the thumbnail toolbar', () => {
  const Module = require('module')
  const resolved = require.resolve('../../../src/main/tomato-taskbar.js')
  delete require.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { nativeImage: { createFromBuffer: () => ({}) } }
    return origLoad.call(this, request, parent, isMain)
  }
  const taskbar = require('../../../src/main/tomato-taskbar.js')
  try {
    taskbar.__test.buttonsSet = true // stale flag left by the dead window
    const deadWin = { isDestroyed: () => true, getTitle: () => 'PickDone' }
    taskbar.init(deadWin)
    assert.equal(taskbar.__test.buttonsSet, false, 'init must re-arm: buttonsSet=false')
  } finally {
    Module._load = origLoad
  }
})
test('taskbar: clearButtons dead-window early return also clears buttonsSet', () => {
  const Module = require('module')
  const resolved = require.resolve('../../../src/main/tomato-taskbar.js')
  delete require.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { nativeImage: { createFromBuffer: () => ({}) } }
    return origLoad.call(this, request, parent, isMain)
  }
  const taskbar = require('../../../src/main/tomato-taskbar.js')
  try {
    taskbar.__test.mainWin = { isDestroyed: () => true }
    taskbar.__test.buttonsSet = true
    taskbar.reset() // reset → clearButtons → dead-window branch
    assert.equal(taskbar.__test.buttonsSet, false, 'dead-window early return must not keep the stale flag')
  } finally {
    Module._load = origLoad
  }
})

/* ---- locked-state gate symmetry in handlers/attachments.js (P2) ---- */
function loadAttachmentHandlers () {
  const Module = require('module')
  const resolved = require.resolve('../../../src/main/handlers/attachments.js')
  delete require.cache[resolved]
  delete require.cache[require.resolve('../../../src/main/attachments.js')]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => process.cwd() }, dialog: {}, shell: { openPath: () => '', openExternal: async () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  const mod = require('../../../src/main/handlers/attachments.js')
  Module._load = origLoad
  return mod
}
test('attachment handlers: open-file / download-file-and-open / save-upload-file-to-download all refuse while locked', () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => true, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.rejects(() => h['open-file']({}, 'local://a.png'), /locked/)
  assert.throws(() => h['download-file-and-open']({}, 'local://a.png'), /locked/)
  assert.throws(() => h['save-upload-file-to-download']({}, 'local://a.png', 'a.png'), /locked/)
})
test('download-file-and-open: returns false for unknown schemes instead of a blanket true', async () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => false, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.equal(h['download-file-and-open']({}, 'javascript:alert(1)'), false)
  assert.equal(await h['open-file']({}, 'weird://x'), false)
})
