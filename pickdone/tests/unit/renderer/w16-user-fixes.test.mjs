/* W16 user-reported batch (2026-10-28) — regression tests, three fixes:
 *   1. [P1] Paste-image broken image: saveAttachment now mints PATH-form local:// urls
 *      (local:///<encoded-key>). Chromium lowercases + IDNA/punycodes the HOST component, so the
 *      old host form 404'd on Chinese/uppercase filenames at the protocol handler. The path
 *      component survives verbatim, so the handler decodes back to the exact on-disk name;
 *      legacy host-form DB rows keep resolving (attachmentKeyOfUrl / attachmentPath strip or
 *      basename the leading '/').
 *   2. [P2] Category dropdown ghost scroll: rows with no id or blank names (LS cache loaded
 *      verbatim) rendered as empty 32px options — setListFromDb now sanitizes at the memory
 *      entry choke point and sortedAll re-gates; EditPanel's assign dropdown additionally
 *      excludes folder rows (leaf-only, matching the roots getter).
 *   3. [P2] Sync version-gate copy: structured codes peer-too-new / peer-too-old (peer-unauthorized
 *      syncEvent) and snapshot-schema-too-new (round-error) map to i18n keys in SettingsSyncTab.
 * Run: node --test tests/unit/renderer/w16-user-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import '../../setup.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- fix 1: path-form local:// urls ---------------- */

const require_ = createRequire(import.meta.url)
const Module = require_('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-user-attach-'))
process.env.TODO_DB_DIR = TMP
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' }, shell: { openPath: async () => '' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachments = require_('../../../src/main/attachments.js')

test('saveAttachment mints a PATH-form local:// url (key in the path component)', async () => {
  const r = await attachments.saveAttachment({ taskId: 't1', name: '截图.PNG', dataBase64: Buffer.from('hello').toString('base64') })
  assert.ok(r.url.startsWith('local:///'), 'url must carry the third slash (path form): ' + r.url)
  assert.equal(r.url, 'local:///' + encodeURIComponent(r.key), 'key must be percent-encoded in the path')
  assert.ok(fs.existsSync(path.join(attachments.attachDir(), r.key)))
})

test('attachmentKeyOfUrl resolves BOTH mint forms to the same on-disk key', async () => {
  const r = await attachments.saveAttachment({ taskId: 't1', name: 'Misdeed Upper Case.png', dataBase64: Buffer.from('x').toString('base64') })
  const fromPath = attachments.attachmentKeyOfUrl('local:///' + encodeURIComponent(r.key))
  const fromLegacy = attachments.attachmentKeyOfUrl('local://' + encodeURIComponent(r.key))
  assert.equal(fromPath, r.key)
  assert.equal(fromLegacy, r.key, 'legacy host-form rows (pre-existing DB data) keep resolving')
  // Chinese name: path form round-trips exactly (host form would be punycoded by Chromium)
  const zh = await attachments.saveAttachment({ taskId: 't1', name: '截图 测试.png', dataBase64: Buffer.from('y').toString('base64') })
  assert.equal(attachments.attachmentKeyOfUrl('local:///' + encodeURIComponent(zh.key)), zh.key)
  assert.equal(attachments.attachmentKeyOfUrl('http://x/y.png'), null)
})

test('attachmentPath resolves both url forms to the same file; findKeyRefs counts path-form refs', async () => {
  const r = await attachments.saveAttachment({ taskId: 't1', name: '共享.png', dataBase64: Buffer.from('z').toString('base64') })
  const p1 = attachments.attachmentPath(attachments.attachmentKeyOfUrl('local:///' + encodeURIComponent(r.key)))
  const p2 = attachments.attachmentPath(attachments.attachmentKeyOfUrl('local://' + encodeURIComponent(r.key)))
  assert.equal(path.basename(p1), r.key)
  assert.equal(p1, p2)
  const rows = [{ taskId: 't2', image: JSON.stringify([{ url: 'local:///' + encodeURIComponent(r.key) }]), files: '[]' }]
  assert.equal(attachments.findKeyRefs(r.key, rows, { excludeTaskId: 't1' }).length, 1,
    'shared-ref counting must see path-form urls or deletes would unlink live files')
})

test('protocol handler key extraction normalizes path-form onto the legacy key (source pin)', () => {
  const src = read('src/main/protocol.js')
  assert.match(src, /keyRaw\.startsWith\('\/'\)/, 'handler must strip the leading / of path-form urls')
  assert.match(src, /decodeURIComponent\(keyRaw\)/)
})

/* ---------------- fix 2: category dropdown ghost rows ---------------- */

const meta = {}
const dbCall = (op, p) => {
  if (op === 'getMeta') return Promise.resolve(meta[p] != null ? meta[p] : null)
  if (op === 'setMeta') { const [k, v] = p; meta[k] = v; return Promise.resolve(true) }
  if (op === 'deleteMeta') { delete meta[p]; return Promise.resolve(true) }
  if (op === 'getAllCategories') return Promise.resolve([])
  if (op === 'getMetaMany') return Promise.resolve((p || []).map(k => ({ key: k, value: meta[k] ?? null })))
  return Promise.resolve(null)
}
if (!globalThis.window) globalThis.window = {}
globalThis.window = Object.assign(globalThis.window, { location: { hash: '' }, todoAPI: { dbCall } })

const Vuex = (await import('vuex')).default
const categoryMod = await import('../../../renderer/js/store/category.js')
const category = categoryMod.default
const makeStore = () => new Vuex.createStore({ modules: { category } })

const live = id => ({ categoryId: id, userId: 1, categoryName: 'C' + id, categoryColor: '#0f9d8f', createTime: id, listSort: id, folderIs: false, folderId: 0, delete: false })

test('isValidCatRow: gates on id presence and non-blank name', () => {
  const { isValidCatRow } = categoryMod
  assert.equal(isValidCatRow(live(1)), true)
  assert.equal(isValidCatRow(null), false)
  assert.equal(isValidCatRow({ ...live(2), categoryId: null }), false)
  assert.equal(isValidCatRow({ ...live(3), categoryName: '' }), false)
  assert.equal(isValidCatRow({ ...live(4), categoryName: '   ' }), false)
})

test('setListFromDb drops live ghost rows but keeps tombstones (recovery metadata)', () => {
  const store = makeStore()
  store.commit('category/setListFromDb', [
    live(1),
    { categoryId: null, categoryName: 'ghost-id', delete: false },
    { categoryId: 2, categoryName: '   ', delete: false },
    { categoryId: 3, categoryName: '', delete: true } // tombstone: odd shape, but recoverable
  ])
  assert.deepEqual(store.state.category.list.filter(c => !c.delete).map(c => c.categoryId), [1])
  assert.ok(store.state.category.list.some(c => c.delete && c.categoryId === 3))
})

test('sortedAll excludes ghost rows (getter-level last line of defense)', () => {
  const store = makeStore()
  store.commit('category/setList', [live(5), { categoryId: '', categoryName: 'x', delete: false }, { ...live(6), folderIs: true }])
  assert.deepEqual(store.getters['category/sortedAll'].map(c => c.categoryId), [5, 6])
})

test('EditPanel assign dropdown is leaf-only (source pin, line-ratchet neutral)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.match(src, /sortedAll'\]\.filter\(c => !c\.folderIs\)/)
})

/* ---------------- fix 3: sync version-gate i18n ---------------- */

test('i18n masters carry the three version-gate keys in en-US and zh-CN', async () => {
  const zh = (await import('../../../renderer/js/i18n/zh-CN.js')).default
  const en = (await import('../../../renderer/js/i18n/en-US.js')).default
  for (const k of ['peerTooNewNotice', 'peerTooOldNotice', 'snapshotSchemaTooNewNotice']) {
    assert.ok(zh.sync[k], 'zh-CN missing sync.' + k)
    assert.ok(en.sync[k], 'en-US missing sync.' + k)
  }
})

test('SYNC_GATE_NOTICE_KEYS maps the three structured codes to those i18n keys (wired in both branches)', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue')
  const m = src.match(/const SYNC_GATE_NOTICE_KEYS[^=]*= (\{[\s\S]*?\n\})/)
  assert.ok(m, 'SYNC_GATE_NOTICE_KEYS const must exist at module scope')
  const map = eval('(' + m[1].replace(/(['"])([\w-]+)\1\s*:/g, '"$2":') + ')')
  assert.deepEqual(map, {
    'peer-too-new': 'sync.peerTooNewNotice',
    'peer-too-old': 'sync.peerTooOldNotice',
    'snapshot-schema-too-new': 'sync.snapshotSchemaTooNewNotice'
  })
  assert.match(src, /SYNC_GATE_NOTICE_KEYS\[evt\.code as string\][\s\S]*?peerUnauthorizedNotice/, 'peer-unauthorized branch consults the code map')
  assert.match(src, /round-error' && SYNC_GATE_NOTICE_KEYS/, 'round-error branch consults the code map')
})
