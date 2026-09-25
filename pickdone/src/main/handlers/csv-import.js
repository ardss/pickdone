/** CSV import IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Worker } = require('worker_threads')
// electron is unavailable when this module is loaded outside Electron (unit tests) — tolerate
let app = null
try { ({ app } = require('electron')) } catch { /* plain node */ }
const i18nM = require('../i18n')
const fixUtil = require('../fix-util')
const scheduler = require('../scheduler')
const appAudit = require('../audit')
const { makeAssertMainWindow } = require('./shared')

// Parsing (detectFormat + rowsToItems) of a <=20MB CSV can freeze the main thread
// for seconds on six-figure-row exports (all window IPC + reminder scheduling stall).
// The parse runs in a worker thread; importItems (DB writes) stays in the main
// process because it shares the app database via cli/lib.js.
const IMPORT_WORKER_TIMEOUT_MS = 30000

function logTerminationFailure (err) {
  try { require('electron-log').warn('[Import] parse worker terminate() failed', err) } catch { /* no logger available */ }
}

function runImportParse (text, format = 'auto') {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // H7 (2026-09-12): terminate() is async and can reject (e.g. while the worker is stuck in a
      // structured-clone of a huge buffer) — an unhandled rejection here would crash the main process.
      // It still cannot FORCE-reclaim such a worker (structural V8 limitation: a clone in flight is not
      // interruptible; the 30s timeout abandons the thread to the OS at app exit) — logged, not hidden.
      try { Promise.resolve(worker.terminate()).catch(err => logTerminationFailure(err)) } catch (err) { logTerminationFailure(err) }
      fn(arg)
    }
    // Packaged: prefer the extraResources copy (worker bootstrap from inside asar is a historical
    // minefield). Dev: process.resourcesPath points at node_modules/electron/dist/resources which has
    // no src/main — resolve from the source tree instead (2026-09-12 release review P2).
    const workerEntry = process.resourcesPath && app.isPackaged
      ? path.join(process.resourcesPath, 'src', 'main', 'import-worker.js')
      : path.join(__dirname, '..', 'import-worker.js')
    const worker = new Worker(workerEntry, { workerData: { text, format } })
    const timer = setTimeout(() => finish(reject, new Error('import: parse worker timed out after ' + IMPORT_WORKER_TIMEOUT_MS + 'ms')), IMPORT_WORKER_TIMEOUT_MS)
    worker.on('message', m => {
      if (m && m.ok) finish(resolve, m)
      else {
        // H8 (2026-09-12): Electron's invoke() rejection serialization strips custom Error props
        // (only name+message survive the context bridge), so a bare perr.code never reaches the
        // renderer. Encode the code INTO the message ('[CODE] original') — the renderer branches
        // on the prefix to show friendly copy (FORMAT_UNKNOWN / EMPTY_FILE).
        const raw = (m && m.error) || 'import: parse worker failed'
        const perr = (m && m.code) ? new Error('[' + m.code + '] ' + raw) : new Error(raw)
        if (m && m.code) perr.code = m.code // kept for in-process consumers (main-process tests)
        finish(reject, perr)
      }
    })
    worker.on('error', err => finish(reject, err))
    worker.on('exit', code => { if (code !== 0) finish(reject, new Error('import: parse worker exited with code ' + code)) })
  })
}

/** sha256 of the exact previewed text (TOCTOU guard, fix 2026-09-19): import:run compares the file's
 *  current content hash against the one approved at preview so the user never executes report B having
 *  approved report A when the file changed between the two IPC calls. */
function textHash (text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

module.exports = function importHandlers (ctx) {
  const { getMainWindow, dbApi, broadcastTodosChanged, log, resyncDbWatch, isLocked } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)
  // main-ipc wave (2026-09-25): both import channels write the whole task table — symmetric with
  // backup.js's per-channel `if (isLocked()) throw new Error('app is locked')` gate (C-2 class:
  // a compromised float/lock-screen window must not be able to write while the lock is active).
  // The gate throws before any dialog/parse/write work.
  const assertNotLocked = () => { if (isLocked && isLocked()) throw new Error('app is locked') }

  let lastPickedImportPath = '' // the only legitimate path source for import:run (the import:pick-preview dialog)
  let lastPickedImportHash = '' // sha256 of the exact text the user previewed/approved

  return {
    // --- CSV import (migrating from other apps): reuses the CLI's cli/import.js engine; both preview and execution go through the main process ---
    // P3 (2026-09-12): expected failures return { ok:false, code, message } instead of throwing —
    // invoke() rejections lose custom Error props across the context bridge, so a thrown code only
    // survived via the '[CODE] message' text hack. null still means "user canceled".
    'import:pick-preview': async (e) => {
      assertMainWindow(e) // H7→H8 fix: must pass the IPC event, not a string label (the string made the guard always-true-reject, killing all CSV imports)
      assertNotLocked()
      const importer = require('../import') // D3 review fix (2026-09-24): engine's in-tree home (src/main/import) — no main->cli reach-back
      const { dialog } = require('electron')
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, {
        title: i18nM.mt('importPickCsv'), properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (r.canceled || !r.filePaths[0]) return null
      const file = r.filePaths[0]
      lastPickedImportPath = file // import:run only allows executing the most recent dialog-picked path (prevents the renderer passing arbitrary paths to read files)
      // 同步 readFileSync 无上限曾把整个主进程(全部窗口/定时器)卡死在大 CSV 上:先 statSync 限 20MB 超限报错(2026-09-09 P2)
      // M-3 (2026-09-20): the statSync moved INSIDE the try — a file deleted between the dialog and
      // the stat used to throw raw ENOENT out of the IPC handler instead of the structured contract.
      try {
        const tooBig = fixUtil.checkImportFileSize(fs.statSync(file).size)
        if (tooBig) return { ok: false, code: 'USAGE', message: tooBig }
        const text = fs.readFileSync(file, 'utf8')
        lastPickedImportHash = textHash(text) // remember what the user actually approved (TOCTOU guard below)
        // rowsToItems 在数十万行时同步阻塞主进程数秒:解析移入 worker 线程(2026-09-12 W1)
        const { format, items } = await runImportParse(text)
        return { ok: true, file, report: importer.importItems(items, { format, dryRun: true }) }
      } catch (err) {
        lastPickedImportHash = '' // failed preview granted nothing: run must re-preview before executing
        // code (FORMAT_UNKNOWN/EMPTY_FILE) rides along when the worker supplied one; undefined code
        // falls back to the renderer's generic import-failed copy
        return { ok: false, code: err && err.code, message: (err && err.message) || String(err) }
      }
    },
    'import:run': async (e, file) => {
      assertMainWindow(e)
      assertNotLocked()
      const importer = require('../import') // D3 review fix (2026-09-24): engine's in-tree home (src/main/import) — no main->cli reach-back
      const f = String(file || '')
      // Arbitrary-path read primitive sealed off: only the path most recently returned by the main-process dialog is accepted.
      // B15 (2026-09-25): a completed/absent grant is now the structured AUTH_EXPIRED contract (see the
      // success-path wipe below) instead of a bare throw — invoke() rejections strip the code across the
      // context bridge, so the renderer could only ever show generic import-failed copy.
      if (!lastPickedImportPath || f !== lastPickedImportPath) {
        return { ok: false, code: 'AUTH_EXPIRED', message: 'import: this run was already executed or the app restarted — pick the file again to preview and approve a fresh import' }
      }
      // H7 2026-09-12 P2: re-stat at run time — the file could have been swapped for a bigger one
      // between import:pick-preview and import:run (TOCTOU on the 20MB cap)
      // M-3 (2026-09-20): a vanished file used to throw raw ENOENT here; return the structured
      // {ok:false, code} contract so the renderer surfaces a proper message instead of a throw.
      let stat
      try { stat = fs.statSync(f) } catch (err) {
        lastPickedImportHash = ''
        return { ok: false, code: 'FILE_MISSING', message: 'import: file no longer readable: ' + ((err && err.message) || String(err)) }
      }
      const tooBig = fixUtil.checkImportFileSize(stat.size)
      // Contract fix (2026-09-25): expected failures return the declared { ok:false, code, message }
      // shape (see the P3 2026-09-12 comment above; FILE_MISSING is the reference) instead of a bare
      // throw — invoke() rejections strip the Error's custom props across the context bridge, so a
      // thrown failure degraded to generic import-failed copy in the renderer.
      if (tooBig) return { ok: false, code: 'USAGE', message: tooBig }
      // TOCTOU content guard (fix 2026-09-19): the file must still be byte-identical to what the user
      // previewed and approved. A changed file previously re-parsed silently — report A approved, report
      // B executed. Abort with a clear error (plus an audit line) and force a fresh preview.
      const text = fs.readFileSync(f, 'utf8')
      if (!lastPickedImportHash || textHash(text) !== lastPickedImportHash) {
        try { appAudit.recordCustom('import', ['import:run', f], [], [], 'aborted: file changed since preview (hash mismatch), re-preview required') } catch { /* best-effort */ }
        return { ok: false, code: 'HASH_MISMATCH', message: 'import: file changed since preview — re-run preview to approve the current content' }
      }
      // same pipeline as importer.importFile, but the text->items parse runs in the worker thread.
      // C9 (2026-09-25): the parse can still fail here at run time (30s worker timeout, worker thread
      // crash mid-clone of a huge buffer) — wrap it into the SAME {ok:false, code, message} contract
      // as every other failure above (:135-139); a bare throw degraded to generic copy in the renderer.
      // C11 (2026-09-25, same PR as C9 by design): the remaining main-thread cost of an import is
      // importItems' own two queryTodos full scans (fingerprint pool + day-sort pool) — the 20MB file
      // cap above bounds them; moving the pool build into the worker / paged reads is the tracked
      // legacy item and must not be "fixed" here by re-reading the file (would race the B7 meta reads
      // of the export path's sibling work).
      let parsed
      try { parsed = await runImportParse(text) } catch (err) {
        return { ok: false, code: err && err.code, message: (err && err.message) || String(err) }
      }
      const { format, items } = parsed
      if (!['ticktick', 'dida365', 'todoist'].includes(format)) {
        return { ok: false, code: 'FORMAT_UNKNOWN', message: `unknown format "${format}" (valid: auto|ticktick|dida365|todoist)` }
      }
      const r = importer.importItems(items, { dryRun: false, format })
      // B13 (2026-09-25): audit single-lining. importItems already lands ONE explicit audit line for
      // every import (both this App path and the CLI path — 'cli/audit' and 'src/main/audit' append to
      // the SAME cli-audit.jsonl), so the extra recordCustom here made App-side imports write TWO
      // lines for one import while CLI imports wrote one. The duplicated block is deleted; the
      // engine's line (with format/duplicates/categories detail) is the single record of truth.
      // H7 (2026-09-12 P1): bulk writes through dbm bypass the todo-db:call write path, so the db-watch
      // baseline was never re-synced — the next watch poll saw the mtime jump, misread OUR OWN import as
      // an EXTERNAL write and triggered a full reload + undo-stack clear (user lost undo history after
      // every import). Re-baseline exactly like handlers/todo.js does after its write ops.
      try { const rw = resyncDbWatch && resyncDbWatch(); if (rw) rw() } catch (err) { log.warn('[Import] resyncDbWatch failed', err) }
      // 与 todo-db:call 写路径对齐(2026-09-09 P2):导入落库后必须刷新调度器并广播,否则应用内导入后
      // 主窗口列表陈旧、已导入的提醒全部静默丢失
      try { scheduler.reloadAll(dbApi()) } catch (err) { log.warn('[Import] reloadAll failed', err) }
      // R4 P2 (2026-09-21): reloadAll itself writes reminderLastSeenAt (touching -wal) AFTER the
      // re-baseline above — the next watch poll would misread that self-write as another EXTERNAL
      // write (full reload + undo wipe). Re-baseline again once the scheduler's own write has
      // landed, same as index.js does at the end of its external-write path.
      try { const rw2 = resyncDbWatch && resyncDbWatch(); if (rw2) rw2() } catch (err) { log.warn('[Import] post-reloadAll resyncDbWatch failed', err) }
      // 2026-09-10 P2:传 e.sender(IpcMainInvokeEvent 本身不是 webContents,exclude 永不命中,
      // 发起导入的窗会被自己的广播打断撤销栈);其余窗照常刷新
      broadcastTodosChanged('import', e.sender)
      // GAP-C fix (2026-09-19): the import writes through dbm.call directly, so the oplog captured
      // the new rows but NO sync round was kicked (resyncDbWatch only re-baselines the db watcher)
      // — imported tasks waited for the whole 5-minute periodic round. Kick a debounced immediate
      // round, same style as the external-db-write path in index.js. Fire-and-forget + guarded:
      // kickSyncRound no-ops safely before sync init.
      try { require('../lan-sync-bootstrap').kickSyncRound('csv-import') } catch { /* sync lazy-not-init */ }
      // B15 (2026-09-25): single-shot execution grant. The preview-approved hash authorized exactly
      // ONE import of these bytes — leaving the grant armed let a double-invoke / re-fired IPC replay
      // the import (harmless-ish only because dedup catches identical rows, but a re-picked DIFFERENT
      // preview on the same path would still run on a stale approval). Clear both; the next import
      // must go through a fresh preview, or import:run returns the structured AUTH_EXPIRED above.
      lastPickedImportPath = ''
      lastPickedImportHash = ''
      return r
    }
  }
}
