/* C10 (2026-09-25, domain-4 wave): tomato-float crash auto-rebuild is CAPPED at 3.
 * The render-process-gone handler used to rebuild the float UNLIMITED — a renderer crashing in
 * a tight loop turned self-heal into a crash-loop generator. Aligned with the main window's
 * precedent (windows.js crashReloadCount < 3): slots refill when a rebuilt window reaches
 * ready-to-show (proof of health) or when the user explicitly opens the float — the auto-rebuild
 * path itself goes through reopen() and can NOT refill its own slots.
 * Run: node --test tests/unit/main/d4-c10-tomato-float-crash-cap-20260925.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

// Minimal electron/db stubs so the module loads without booting any real window.
const stubs = {
  electron: {
    app: { getPath: () => process.env.TEMP || '/tmp', isPackaged: false },
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 }, bounds: { x: 0, y: 0, width: 800, height: 600 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), on () {}, getAllDisplays: () => [] },
  },
  '../db': { isOpen: () => false, call: () => null },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tomatoFloat = require_('../../../src/main/tomato-float.js')

test('C10: 3 consecutive crash rebuilds allowed, the 4th refused; a health reset refills', () => {
  const g = tomatoFloat.crashRebuild
  g.reset()
  assert.equal(g.count, 0)
  // 模拟连续 render-process-gone:第 1-3 次允许自动重建,第 4 次不再重建。
  assert.equal(g.allow(), true, 'crash 1: rebuild')
  assert.equal(g.allow(), true, 'crash 2: rebuild')
  assert.equal(g.allow(), true, 'crash 3: rebuild')
  assert.equal(g.allow(), false, 'crash 4: NO rebuild (cap aligns with windows.js <3 precedent)')
  assert.equal(g.allow(), false, 'still refused while exhausted — the brake holds')
  // Health signals refill: rebuilt window reached ready-to-show, or the user opened the float.
  g.reset()
  assert.equal(g.allow(), true, 'reset refills the slots')
  assert.equal(g.count, 1, 'the consumed slot is counted')
})
