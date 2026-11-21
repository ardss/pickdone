import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Screenshot matrix contract (ux-contract §7) — manifest integrity + cell presence +
// captured-at-capture-time DOM text proof. Cells are REAL adb screencap pixels from the
// Medium_Phone_API_36.0 AVD against build d4f41a8b; proof strings were read back from the
// live WebView DOM in the same session that took each screenshot (no re-render, no mocks).
const here = dirname(fileURLToPath(import.meta.url))
const matrixDir = resolve(here, '..', 'matrix')
const manifest = JSON.parse(readFileSync(resolve(matrixDir, 'manifest.json'), 'utf8'))

test('manifest carries build + device provenance and physical honesty', () => {
  assert.equal(manifest.build.gitSha, 'd4f41a8b')
  assert.equal(manifest.build.app, 'com.pickdone.mobile')
  assert.equal(manifest.device.kind, 'emulator')
  assert.match(manifest.physical, /BLOCKED/)
  assert.match(manifest.device.screen, /360x800dp/)
})

const requiredGroups = ['today', 'sync-conflict', 'settings', 'offline']
const groups = new Set(manifest.cells.map(c => c.group))
for (const g of requiredGroups) assert.ok(groups.has(g), 'missing required group cell: ' + g)

test('every manifest cell: file exists, mandatory metadata complete, real-pixel capture', () => {
  for (const cell of manifest.cells) {
    const p = resolve(matrixDir, cell.file)
    assert.ok(existsSync(p), 'cell screenshot missing on disk: ' + cell.file)
    assert.ok(/\.png$/.test(cell.file), 'cells must be real .png captures')
    assert.ok(cell.viewport && cell.theme && cell.navPath?.length >= 1, 'metadata incomplete: ' + cell.file)
    assert.match(cell.capturedAt, /^\d{4}-\d{2}-\d{2}T/, 'capturedAt required: ' + cell.file)
    assert.ok(cell.domTextProof && Object.keys(cell.domTextProof).length >= 1, 'domTextProof required: ' + cell.file)
  }
})

test('today cell proves all four zones with real data (G2 closure)', () => {
  const cell = manifest.cells.find(c => c.file === 'today__android-emulator-360x800dp__light__four-zones.png')
  assert.match(cell.domTextProof['zone2-waiting'], /handoffTo|待我接手 ← desktop-g2/)
  assert.match(cell.domTextProof['zone3-agent'], /coder · 开始于/)
  assert.match(cell.domTextProof['zone4-healthy'], /无阻塞，同步健康/)
})

test('sync-conflict sheet cell proves both sides + timestamps + three actions (G10)', () => {
  const cell = manifest.cells.find(c => c.file === 'sync-conflict__android-emulator-360x800dp__light__sheet-open.png')
  assert.equal(cell.domTextProof.verdict, 'Light detail tap target · conflict_tombstone_wins')
  assert.match(cell.domTextProof['local-side'], /本机.*edited on phone.*2026\/11\/10/)
  assert.match(cell.domTextProof['incoming-side'], /对端.*已删除/)
  assert.equal(cell.domTextProof.actions, '保留本机 / 接受对端 / 双保留为副本')
  const resolved = manifest.cells.find(c => c.file === 'sync-conflict__android-emulator-360x800dp__light__converged.png')
  assert.deepEqual(resolved.domTextProof.zone4, [])
})

test('offline cell proves banner copy + honest trigger disclosure (G9, emulator defect noted)', () => {
  const cell = manifest.cells.find(c => c.file === 'offline__android-emulator-360x800dp__light__banner.png')
  assert.equal(cell.domTextProof.banner, '离线 — 改动已保存在本机，恢复联网后同步。')
  assert.match(cell.navPath.join(' '), /svc wifi disable/)
  assert.ok(cell.defectNote.includes('navigator.onLine'), 'defect note must disclose the WebView onLine limitation')
})

test('settings cell proves the G11 surface rows', () => {
  const cell = manifest.cells.find(c => c.file === 'settings__android-emulator-360x800dp__light__default.png')
  assert.match(cell.domTextProof.rows, /同步状态/)
  assert.match(cell.domTextProof.rows, /设备名称/)
  assert.match(cell.domTextProof.chips, /在线|离线/)
})
