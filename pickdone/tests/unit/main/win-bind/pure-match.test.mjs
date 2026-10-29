/** T7 slice-1 RED tests — pure matching engine (src/main/win-bind/pure/match.js).
 *  Contract (task ask): normProcName / isDesktopWindow / isBindableWindow / decideIdentify /
 *  resolveBinding as frozen six-field WindowRef semantics. These start RED (module absent),
 *  go green, then move to tests/unit/main/win-bind/ with re-pointed imports. */
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const M = require('../../../../src/main/win-bind/pure/match.js')

test('normProcName: lowercase + strip trailing .exe (idempotent both sides)', () => {
  assert.equal(M.normProcName('NotePad.EXE'), 'notepad')
  assert.equal(M.normProcName('notepad.exe'), 'notepad')
  assert.equal(M.normProcName('chrome'), 'chrome')
  assert.equal(M.normProcName(''), '')
  assert.equal(M.normProcName(undefined), '')
  assert.equal(M.normProcName('already.exe.exe'), 'already.exe') // only ONE trailing .exe stripped
})

test('isDesktopWindow: explorer + (Program Manager | empty title)', () => {
  assert.equal(M.isDesktopWindow({ processName: 'explorer', title: 'Program Manager' }), true)
  assert.equal(M.isDesktopWindow({ processName: 'Explorer.EXE', title: '' }), true)
  assert.equal(M.isDesktopWindow({ processName: 'explorer', title: 'Downloads' }), false)
  assert.equal(M.isDesktopWindow({ processName: 'notepad', title: 'Program Manager' }), false)
})

test('isBindableWindow: hwnd+pid present, not own pid, not desktop', () => {
  const ok = { hwnd: 723854, pid: 45504, processName: 'notepad', execPath: 'C:\\x\\notepad.exe', title: 't' }
  assert.equal(M.isBindableWindow(ok, 9999), true)
  assert.equal(M.isBindableWindow({ ...ok, hwnd: 0 }, 9999), false)
  assert.equal(M.isBindableWindow({ ...ok, pid: 0 }, 9999), false)
  assert.equal(M.isBindableWindow(ok, 45504), false) // own pid
  assert.equal(M.isBindableWindow({ ...ok, processName: 'explorer', title: 'Program Manager' }, 9999), false)
})

test('makeRef: WindowInfo → six-field WindowRef, boundAt 0, normalized processName, storage caps', () => {
  const ref = M.makeRef({ hwnd: 723854, pid: 45504, processName: 'Notepad.exe', execPath: 'C:\\Windows\\system32\\notepad.exe', title: '*无标题 - 记事本' })
  assert.deepEqual(ref, {
    processName: 'notepad', execPath: 'C:\\Windows\\system32\\notepad.exe', title: '*无标题 - 记事本',
    pidHint: 45504, hwnd: 723854, boundAt: 0
  })
  // storage caps: title 512 / execPath 1024 / processName 256
  const long = M.makeRef({ hwnd: 1, pid: 2, processName: 'p'.repeat(300), execPath: 'e'.repeat(2000), title: 't'.repeat(600) })
  assert.equal(long.title.length, 512)
  assert.equal(long.execPath.length, 1024)
  assert.equal(long.processName.length, 256)
})

test('decideIdentify: BUTTON_DOWN wins over everything; null/undefined buttonDown does not block', () => {
  assert.deepEqual(M.decideIdentify({ raw: null, buttonDown: true, ownPid: 1 }), { window: null, reason: 'BUTTON_DOWN' })
  const win = { hwnd: 1, pid: 2, processName: 'notepad', execPath: '', title: 'x' }
  assert.equal(M.decideIdentify({ raw: win, buttonDown: null, ownPid: 99 }).reason, null)
  assert.equal(M.decideIdentify({ raw: win, buttonDown: undefined, ownPid: 99 }).reason, null)
})

test('decideIdentify: NO_WINDOW / OWN_WINDOW / DESKTOP / happy path', () => {
  assert.deepEqual(M.decideIdentify({ raw: null, buttonDown: false, ownPid: 1 }), { window: null, reason: 'NO_WINDOW' })
  const own = { hwnd: 1, pid: 77, processName: 'pickdone', execPath: '', title: 'x' }
  assert.deepEqual(M.decideIdentify({ raw: own, buttonDown: false, ownPid: 77 }), { window: null, reason: 'OWN_WINDOW' })
  const desk = { hwnd: 2, pid: 88, processName: 'explorer', execPath: '', title: 'Program Manager' }
  assert.deepEqual(M.decideIdentify({ raw: desk, buttonDown: false, ownPid: 77 }), { window: null, reason: 'DESKTOP' })
  const r = M.decideIdentify({ raw: { hwnd: 3, pid: 90, processName: 'Notepad.exe', execPath: '', title: 'y' }, buttonDown: false, ownPid: 77 })
  assert.equal(r.reason, null)
  assert.equal(r.window.processName, 'notepad')
  assert.equal(r.window.boundAt, 0)
})

const REF = { processName: 'notepad', execPath: '', title: '*无标题 - 记事本', pidHint: 45504, hwnd: 723854, boundAt: 1 }

test('resolveBinding: own-pid snapshot rows are filtered out (step 0), even on an HWND/pid fastpath collision', () => {
  const res = M.resolveBinding({ taskId: 't', ref: { ...REF, pidHint: 77 } }, [
    { hwnd: 723854, pid: 77, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' }
  ], 77)
  assert.deepEqual(res, { status: 'NOT_FOUND' })
})

test('resolveBinding: HWND same-session fastpath — title changed still FOUND', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 723854, pid: 45504, processName: 'notepad', execPath: '', title: 'TOTALLY DIFFERENT TAB' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 723854, via: 'HWND_FASTPATH' })
})

test('resolveBinding: handle-reuse trap — same hwnd but different pid is NOT fastpath, falls to ladder', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 723854, pid: 99999, processName: 'notepad', execPath: '', title: 'unrelated' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 723854, via: 'PROCESS_UNIQUE' })
})

test('resolveBinding: same instance, exactly one pid match → PID (title drift tolerated)', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 1, pid: 45504, processName: 'notepad', execPath: '', title: 'another title' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 1, via: 'PID' })
})

test('resolveBinding: same instance, >1 pid matches narrowed by exact title → PID_TITLE', () => {
  // both candidate hwnds differ from ref.hwnd so the HWND fastpath does not fire first
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 11, pid: 45504, processName: 'notepad', execPath: '', title: 'other' },
    { hwnd: 12, pid: 45504, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 12, via: 'PID_TITLE' })
})

test('resolveBinding: same-instance >1 with 0 or >1 title hits → AMBIGUOUS, never falls to the restart ladder', () => {
  // 0 title hits + a pid-mismatched same-process window exists: still AMBIGUOUS on the pid set
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 1, pid: 45504, processName: 'notepad', execPath: '', title: 'a' },
    { hwnd: 2, pid: 45504, processName: 'notepad', execPath: '', title: 'b' },
    { hwnd: 3, pid: 777, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' }
  ], 999)
  assert.equal(res.status, 'AMBIGUOUS')
  assert.equal(res.candidates.length, 2) // the pid-matched pair, not the restarted one
})

test('resolveBinding: app restarted (pid gone), unique process → PROCESS_UNIQUE even with title drift', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 5, pid: 12000, processName: 'notepad', execPath: '', title: 'new title after restart' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 5, via: 'PROCESS_UNIQUE' })
})

test('resolveBinding: restart with >1 same-process candidates, exact title narrows → PROCESS_TITLE', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 5, pid: 12000, processName: 'notepad', execPath: '', title: 'zzz' },
    { hwnd: 6, pid: 13000, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' }
  ], 999)
  assert.deepEqual(res, { status: 'FOUND', hwnd: 6, via: 'PROCESS_TITLE' })
})

test('resolveBinding: same title, same process, multiple windows → AMBIGUOUS with candidates (never guess)', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 5, pid: 12000, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' },
    { hwnd: 6, pid: 13000, processName: 'notepad', execPath: '', title: '*无标题 - 记事本' }
  ], 999)
  assert.equal(res.status, 'AMBIGUOUS')
  assert.deepEqual(res.candidates.map(c => c.hwnd).sort(), [5, 6])
})

test('resolveBinding: zero processName hits → NOT_FOUND', () => {
  const res = M.resolveBinding({ taskId: 't', ref: REF }, [
    { hwnd: 5, pid: 12000, processName: 'chrome', execPath: '', title: 'x' }
  ], 999)
  assert.deepEqual(res, { status: 'NOT_FOUND' })
})
