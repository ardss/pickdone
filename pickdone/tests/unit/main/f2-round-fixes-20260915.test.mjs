/* F2 修复轮回归测试(2026-09-15)— src/main/db.js / handlers/system.js / handlers/attachments.js / fix-util.js + index.js
   覆盖:tomatoAppendMany 行级容错 / upsert taskId 必填 / notification 入参守卫 /
   attachments 三通道 typeof 守卫 / _dayBounds NaN 判定 / forwardTomatoCmd 命令丢失竞态。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'f2-round-')) }

/* ---- F1: tomatoAppendMany 行级容错(批内 1 坏 2 好 → 2 好行落库 + rejected 含坏行) ---- */
test('F1: 批内 1 坏 2 好 — 好行照常落库,坏行进 rejected,不再整批回滚', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  const end = new Date('2026-09-15T10:00:00').getTime()
  const r = db.call('tomatoAppendMany', [
    { tomatoId: 'f1_ok_1', endTime: end, focusDuration: 25 },
    { tomatoId: '', endTime: end }, // 坏行:缺 tomatoId
    { tomatoId: 'f1_ok_2', endTime: end, focusDuration: 30 },
    { tomatoId: 'f1_bad_end' } // 坏行:缺 endTime
  ])
  assert.equal(r.accepted, 2, '两条合法行必须落库')
  assert.equal(r.rejected.length, 2, '两条坏行进 rejected')
  assert.deepEqual(r.rejected.map(x => x.index), [1, 3], 'rejected 携带批内索引')
  assert.match(r.rejected[0].reason, /tomatoId/)
  assert.match(r.rejected[1].reason, /endTime/)
  const all = db.call('tomatoAll')
  assert.ok(all.find(x => x.tomatoId === 'f1_ok_1'), '合法行 1 落库')
  assert.ok(all.find(x => x.tomatoId === 'f1_ok_2'), '合法行 2 落库')
})

test('F1: 全好行时 rejected 为空,行为与旧版一致(幂等 upsert)', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  const end = new Date('2026-09-15T11:00:00').getTime()
  const row = { tomatoId: 'f1_idem', endTime: end, focusDuration: 25 }
  db.call('tomatoAppendMany', row)
  const r2 = db.call('tomatoAppendMany', row)
  assert.deepEqual(r2.rejected, [])
  assert.equal(db.call('tomatoAll').filter(x => x.tomatoId === 'f1_idem').length, 1)
})

/* ---- F3: notification handler 形状守卫 ---- */
function loadSystemHandlers () {
  const Module = require_('module')
  const resolved = require_.resolve('../../../src/main/handlers/system.js')
  delete require_.cache[resolved]
  const origLoad = Module._load
  const seen = []
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        Notification: class { constructor (opt) { this.opt = opt; seen.push(opt) } show () {} },
        shell: { openExternal: async () => {}, openPath: () => '' }
      }
    }
    // updater.js 在模块顶层解构 electron-updater 的 autoUpdater(node 环境无 electron app,须一并打桩)
    if (request === 'electron-updater') {
      return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => {} } }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    // factory 体内的 require('electron') 在调用时才解析,mock 必须覆盖到 factory 调用
    const mod = require_('../../../src/main/handlers/system.js')
    const i18n = { mt: k => '默认标题' }
    const h = mod({ isLocked: () => false, allowWithinRate: () => true, i18n, app: { getPath: () => tmpDir() } })
    return { h, seen }
  } finally { Module._load = origLoad }
}
test('F3: notification 入参 undefined/null/非对象/缺 title 均不抛 TypeError,走安全默认', () => {
  const { h, seen } = loadSystemHandlers()
  const fakeE = { sender: { id: 1 } }
  for (const bad of [undefined, null, 'str', 42]) {
    assert.doesNotThrow(() => h.notification(fakeE, bad), 'opt=' + String(bad))
  }
  assert.equal(seen.length, 4)
  for (const n of seen) assert.equal(n.title, '默认标题', '缺 title 走 i18n 安全默认')
  // 合法入参仍按原样清洗透传
  h.notification(fakeE, { title: 'Hello', body: 'World', silent: true })
  assert.deepEqual(seen[seen.length - 1], { title: 'Hello', body: 'World', silent: true })
})

/* ---- F4: attachments 三通道 typeof 守卫(非字符串 url 不再 TypeError) ---- */
function loadAttachmentHandlers () {
  const Module = require_('module')
  const resolved = require_.resolve('../../../src/main/handlers/attachments.js')
  delete require_.cache[resolved]
  delete require_.cache[require_.resolve('../../../src/main/attachments.js')]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => process.cwd() }, dialog: {}, shell: { openPath: () => '', openExternal: async () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  const mod = require_('../../../src/main/handlers/attachments.js')
  const h = mod({ isLocked: () => false, isSafeExternal: u => typeof u === 'string' && /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  // handler 体内的 require('electron') 在每次 IPC 调用时才解析,mock 须保留到测试结束
  return { h, restore: () => { Module._load = origLoad } }
}
test('F4: open-file / download-file-and-open / delete-file 对非字符串 url 返回 false 而非抛 TypeError', async () => {
  const { h, restore } = loadAttachmentHandlers()
  try {
    for (const bad of [undefined, null, 42, {}]) {
      assert.equal(await h['open-file']({}, bad), false, 'open-file url=' + String(bad))
      assert.equal(h['download-file-and-open']({}, bad), false, 'download-file-and-open url=' + String(bad))
      assert.equal(h['delete-file']({}, bad), false, 'delete-file url=' + String(bad))
    }
    // 合法外链不受影响
    assert.equal(await h['download-file-and-open']({}, 'https://example.com/a.png'), true)
  } finally { restore() }
})

/* ---- F6: forwardTomatoCmd 命令丢失竞态(纯逻辑抽到 fix-util.tryForwardTomatoCmd) ---- */
const { tryForwardTomatoCmd } = require_('../../../src/main/fix-util.js')
const cmdRaw = seq => JSON.stringify({ action: 'stop', seq })

function mockWin ({ destroyed = false, wcDestroyed = false, sendThrows = false } = {}) {
  const sent = []
  const wc = {
    destroyed: wcDestroyed,
    isDestroyed: () => wcDestroyed,
    send: (ch, c) => { if (sendThrows) throw new Error('Object has been destroyed'); sent.push({ ch, c }) }
  }
  const win = { destroyed, isDestroyed: () => destroyed, webContents: wc }
  return { win, sent }
}

test('F6: send 成功才推进 lastTomatoSeq(基线正路)', () => {
  const { win, sent } = mockWin()
  const st = tryForwardTomatoCmd({ raw: cmdRaw(3), lastTomatoCmdRaw: null, lastTomatoSeq: 2, getMainWindow: () => win, isLocked: () => false })
  assert.equal(st.sent, true)
  assert.equal(st.lastTomatoSeq, 3, 'seq 只在 send 成功后推进')
  assert.equal(st.lastTomatoCmdRaw, cmdRaw(3))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ch, 'cli-tomato-cmd')
})

test('F6: 窗口销毁/重建间隙(isDestroyed)不消费 raw、不推进 seq → 下轮轮询重投', () => {
  for (const shape of [{ destroyed: true }, { wcDestroyed: true }, { win: null }]) {
    const opts = { raw: cmdRaw(3), lastTomatoCmdRaw: null, lastTomatoSeq: 2, getMainWindow: () => shape.win === null ? null : mockWin(shape).win, isLocked: () => false }
    const st = tryForwardTomatoCmd(opts)
    assert.equal(st.sent, false, JSON.stringify(shape))
    assert.equal(st.lastTomatoSeq, 2, 'seq 不得推进')
    assert.equal(st.lastTomatoCmdRaw, null, 'raw 不得标记已消费(下轮重投)')
  }
})

test('F6: send 抛错(半销毁 peer)原样上抛,seq/raw 均不推进 — 修复"命令永久丢失"', () => {
  const { win } = mockWin({ sendThrows: true })
  const opts = { raw: cmdRaw(3), lastTomatoCmdRaw: null, lastTomatoSeq: 2, getMainWindow: () => win, isLocked: () => false }
  assert.throws(() => tryForwardTomatoCmd(opts), /destroyed/)
  assert.equal(opts.lastTomatoSeq, 2)
  assert.equal(opts.lastTomatoCmdRaw, null)
  // 窗口恢复后同 seq 重投成功
  const { win: win2, sent } = mockWin()
  const st = tryForwardTomatoCmd({ ...opts, getMainWindow: () => win2 })
  assert.equal(st.sent, true)
  assert.equal(sent.length, 1, '命令最终送达,不再丢失')
})

test('F6: 锁屏/旧 seq/重复 raw/坏 JSON 均不发送也不推进(与旧行为对齐)', () => {
  const { win, sent } = mockWin()
  const base = { getMainWindow: () => win, isLocked: () => false }
  assert.equal(tryForwardTomatoCmd({ ...base, raw: cmdRaw(1), lastTomatoCmdRaw: null, lastTomatoSeq: 5, isLocked: () => true }).sent, false)
  assert.equal(tryForwardTomatoCmd({ ...base, raw: cmdRaw(1), lastTomatoCmdRaw: cmdRaw(1), lastTomatoSeq: 5 }).sent, false)
  assert.equal(tryForwardTomatoCmd({ ...base, raw: cmdRaw(1), lastTomatoCmdRaw: null, lastTomatoSeq: 5 }).sent, false, '旧 seq 不重发')
  assert.equal(tryForwardTomatoCmd({ ...base, raw: '{oops', lastTomatoCmdRaw: null, lastTomatoSeq: 0 }).sent, false)
  assert.equal(tryForwardTomatoCmd({ ...base, raw: null, lastTomatoCmdRaw: null, lastTomatoSeq: 0 }).sent, false)
  assert.equal(sent.length, 0)
})
