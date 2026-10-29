/** T7 slice-3 live tests — REAL resident PowerShell probe, guarded on win32.
 *  activate is deliberately NOT exercised live: SetForegroundWindow steals the user's real
 *  foreground focus (a state-mutating action — field-probing discipline forbids it; the
 *  contract marks its behavior UNVERIFIED-live with failure-feedback paths covered in unit
 *  tests instead). */
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createWinAdapter } = require('../../../../src/main/win-bind/adapter.js')

const isWin32 = process.platform === 'win32'

test('live enumerate: resident PS returns real visible windows with well-formed rows', { skip: !isWin32 }, async () => {
  const a = createWinAdapter({ timeoutMs: 8000 })
  try {
    await a.prewarm()
    const rows = await a.enumerate()
    assert.ok(Array.isArray(rows), 'enumerate returns an array')
    assert.ok(rows.length >= 1, 'a desktop session always has at least the Progman root')
    for (const w of rows) {
      assert.equal(typeof w.hwnd, 'number'); assert.ok(w.hwnd > 0)
      assert.equal(typeof w.pid, 'number'); assert.ok(w.pid > 0)
      assert.equal(typeof w.processName, 'string')
      assert.equal(typeof w.execPath, 'string')
      assert.equal(typeof w.title, 'string')
    }
    // the desktop root is a stable fixture on every Windows session
    assert.ok(rows.some(w => w.processName === 'explorer' && w.title === 'Program Manager'),
      'explorer/Program Manager desktop root present')
  } finally { a.dispose() }
})

test('live probeUnderCursor: never throws; shape {raw: WindowInfo|null, buttonDown: boolean|null}', { skip: !isWin32 }, async () => {
  const a = createWinAdapter({ timeoutMs: 8000 })
  try {
    await a.prewarm()
    const out = await a.probeUnderCursor()
    assert.ok(out && typeof out === 'object')
    assert.ok(out.buttonDown === true || out.buttonDown === false || out.buttonDown === null)
    if (out.raw != null) {
      assert.equal(typeof out.raw.hwnd, 'number'); assert.ok(out.raw.hwnd > 0)
      assert.equal(typeof out.raw.pid, 'number'); assert.ok(out.raw.pid > 0)
      assert.equal(typeof out.raw.processName, 'string')
      assert.equal(typeof out.raw.title, 'string')
    }
    // resident child: a second probe must answer fast (no re-compile)
    const t0 = Date.now()
    await a.probeUnderCursor()
    assert.ok(Date.now() - t0 < 2000, 'second probe rides the resident child')
  } finally { a.dispose() }
})
