/** T7 win-bind pure matching engine — the ONLY cross-layer data shape is the six-field
 *  WindowRef (frozen contract, see the task ask):
 *    { processName, execPath, title, pidHint, hwnd, boundAt }
 *
 *  Types (JSDoc):
 *    WindowInfo = { hwnd:number, pid:number, processName:string, execPath:string, title:string }
 *      — an EnumWindows/product snapshot row (or a test fixture); processName may arrive raw
 *      (with .exe / mixed case) — every consumer normalizes through normProcName.
 *    IdentifyResult = { window: WindowRef|null, reason: 'NO_WINDOW'|'OWN_WINDOW'|'DESKTOP'|
 *      'BUTTON_DOWN'|'ADAPTER_ERROR'|'TIMEOUT'|null } — window non-null ⟹ reason null.
 *    ResolveResult = { status:'FOUND', hwnd:number, via:string } |
 *      { status:'NOT_FOUND' } | { status:'AMBIGUOUS', candidates:WindowInfo[] }
 *
 *  Pure functions, zero deps, CommonJS — requireable from node --test. */
'use strict'

/** Storage caps (frozen contract): title 512 / execPath 1024 / processName 256. */
const CAP_TITLE = 512
const CAP_EXEC = 1024
const CAP_PROC = 256

/** Process-name normalization: lowercase + strip ONE trailing '.exe'. Get-Process names arrive
 *  without .exe while MainModule.ModuleName arrives with — both sides land on the same form,
 *  so this is the #1 matching key. Idempotent-ish: already-normalized names pass through. */
function normProcName (s) {
  let v = String(s == null ? '' : s).toLowerCase()
  if (v.endsWith('.exe')) v = v.slice(0, -4)
  return v
}

/** Desktop detection: the Progman/WorkerW desktop root. Field probing (task ask) proved
 *  WindowFromPoint over the bare desktop returns exactly this shape. */
function isDesktopWindow (info) {
  if (!info || typeof info !== 'object') return false
  return normProcName(info.processName) === 'explorer' && (info.title === 'Program Manager' || info.title === '')
}

/** Bindable check: real root window (hwnd+pid), not our own process, not the desktop. */
function isBindableWindow (info, ownPid) {
  if (!info || typeof info !== 'object') return false
  if (!info.hwnd || !info.pid || info.pid === ownPid) return false
  return !isDesktopWindow(info)
}

/** WindowInfo → WindowRef. boundAt stays 0 here (identify result); the main process stamps
 *  Date.now() at bind() time. Caps are applied at the single shape-construction point so every
 *  persisted ref is born within the caps (task ask: title 512 / execPath 1024 / processName 256). */
function makeRef (raw) {
  return {
    processName: normProcName(raw && raw.processName).slice(0, CAP_PROC),
    execPath: String(raw && raw.execPath != null ? raw.execPath : '').slice(0, CAP_EXEC),
    title: String(raw && raw.title != null ? raw.title : '').slice(0, CAP_TITLE),
    pidHint: Number(raw && raw.pid) || 0,
    hwnd: Number(raw && raw.hwnd) || 0,
    boundAt: 0
  }
}

/** F1 identify pipeline. Order (frozen contract):
 *  1) buttonDown===true → BUTTON_DOWN (the drag is still holding the mouse — the cursor is
 *     ours, not the target's); null/undefined = adapter could not read it → do NOT block.
 *  2) raw==null → NO_WINDOW; 3) pid===ownPid → OWN_WINDOW; 4) desktop → DESKTOP;
 *  5) otherwise makeRef(raw) with reason null. */
function decideIdentify (input) {
  const { raw, buttonDown, ownPid } = input || {}
  if (buttonDown === true) return { window: null, reason: 'BUTTON_DOWN' }
  if (raw == null) return { window: null, reason: 'NO_WINDOW' }
  if (raw.pid === ownPid) return { window: null, reason: 'OWN_WINDOW' }
  if (isDesktopWindow(raw)) return { window: null, reason: 'DESKTOP' }
  return { window: makeRef(raw), reason: null }
}

/** Narrow a candidate list by exact title equality. */
function byExactTitle (cands, title) {
  return cands.filter(c => c.title === title)
}

/** F3/F4 relocation ladder (frozen contract). Never trusts an old HWND across pids — HWND is a
 *  handle-table slot value and gets REUSED after app restart, so hwnd equality with a different
 *  pid is treated as coincidence and falls through to the processName ladder.
 *    0) snapshot rows with pid===ownPid are dropped first;
 *    1) HWND same-session fastpath: hwnd match AND pid===ref.pidHint → HWND_FASTPATH (title
 *       drift tolerated — browser tab switch);
 *    2) same instance: processName match && pid===pidHint; exactly 1 → PID; >1 narrowed by
 *       exact title → PID_TITLE; still >1 or 0 → AMBIGUOUS (stops here — no restart ladder);
 *    3) app restarted (pid gone): processName matches; exactly 1 → PROCESS_UNIQUE (title drift
 *       tolerated); >1 narrowed by exact title → PROCESS_TITLE; still >1 or 0 title hits →
 *       AMBIGUOUS with candidates;
 *    4) zero processName hits → NOT_FOUND. Ambiguity is never guessed away. */
function resolveBinding (binding, windows, ownPid) {
  const ref = binding && binding.ref ? binding.ref : {}
  const refProc = normProcName(ref.processName)
  const snap = (windows || []).filter(w => w && w.pid !== ownPid)

  // 1) HWND same-session fastpath (pid must still hold the handle)
  for (const w of snap) {
    if (w.hwnd === ref.hwnd && w.pid === ref.pidHint) {
      return { status: 'FOUND', hwnd: w.hwnd, via: 'HWND_FASTPATH' }
    }
  }

  // 2) same instance: processName + pid
  const samePid = snap.filter(w => normProcName(w.processName) === refProc && w.pid === ref.pidHint)
  if (samePid.length === 1) return { status: 'FOUND', hwnd: samePid[0].hwnd, via: 'PID' }
  if (samePid.length > 1) {
    const hits = byExactTitle(samePid, ref.title)
    if (hits.length === 1) return { status: 'FOUND', hwnd: hits[0].hwnd, via: 'PID_TITLE' }
    return { status: 'AMBIGUOUS', candidates: hits.length > 0 ? hits : samePid }
  }

  // 3) app restarted: pid gone/dead, processName only
  const sameProc = snap.filter(w => normProcName(w.processName) === refProc)
  if (sameProc.length === 0) return { status: 'NOT_FOUND' }
  if (sameProc.length === 1) return { status: 'FOUND', hwnd: sameProc[0].hwnd, via: 'PROCESS_UNIQUE' }
  const procHits = byExactTitle(sameProc, ref.title)
  if (procHits.length === 1) return { status: 'FOUND', hwnd: procHits[0].hwnd, via: 'PROCESS_TITLE' }
  return { status: 'AMBIGUOUS', candidates: procHits.length > 0 ? procHits : sameProc }
}

module.exports = { normProcName, isDesktopWindow, isBindableWindow, makeRef, decideIdentify, resolveBinding, CAP_TITLE, CAP_EXEC, CAP_PROC }
