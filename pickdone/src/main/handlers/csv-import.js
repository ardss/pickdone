/** CSV import IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')
const i18nM = require('../i18n')
const fixUtil = require('../fix-util')
const scheduler = require('../scheduler')
const appAudit = require('../audit')

// Parsing (detectFormat + rowsToItems) of a <=20MB CSV can freeze the main thread
// for seconds on six-figure-row exports (all window IPC + reminder scheduling stall).
// The parse runs in a worker thread; importItems (DB writes) stays in the main
// process because it shares the app database via cli/lib.js.
const IMPORT_WORKER_TIMEOUT_MS = 30000

function runImportParse (text, format = 'auto') {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { worker.terminate() } catch { /* already dead */ }
      fn(arg)
    }
    const worker = new Worker(path.join(__dirname, '..', 'import-worker.js'), { workerData: { text, format } })
    const timer = setTimeout(() => finish(reject, new Error('import: parse worker timed out after ' + IMPORT_WORKER_TIMEOUT_MS + 'ms')), IMPORT_WORKER_TIMEOUT_MS)
    worker.on('message', m => {
      if (m && m.ok) finish(resolve, m)
      else finish(reject, new Error((m && m.error) || 'import: parse worker failed'))
    })
    worker.on('error', err => finish(reject, err))
    worker.on('exit', code => { if (code !== 0) finish(reject, new Error('import: parse worker exited with code ' + code)) })
  })
}

module.exports = function importHandlers (ctx) {
  const { getMainWindow, dbApi, broadcastTodosChanged, log } = ctx

  let lastPickedImportPath = '' // the only legitimate path source for import:run (the import:pick-preview dialog)

  return {
    // --- CSV import (migrating from other apps): reuses the CLI's cli/import.js engine; both preview and execution go through the main process ---
    'import:pick-preview': async () => {
      const importer = require('../../../cli/import.js')
      const { dialog } = require('electron')
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, {
        title: i18nM.mt('importPickCsv'), properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (r.canceled || !r.filePaths[0]) return null
      const file = r.filePaths[0]
      lastPickedImportPath = file // import:run only allows executing the most recent dialog-picked path (prevents the renderer passing arbitrary paths to read files)
      // 同步 readFileSync 无上限曾把整个主进程(全部窗口/定时器)卡死在大 CSV 上:先 statSync 限 20MB 超限报错(2026-09-09 P2)
      const tooBig = fixUtil.checkImportFileSize(fs.statSync(file).size)
      if (tooBig) throw new Error(tooBig)
      const text = fs.readFileSync(file, 'utf8')
      // rowsToItems 在数十万行时同步阻塞主进程数秒:解析移入 worker 线程(2026-09-12 W1)
      const { format, items } = await runImportParse(text)
      return { file, report: importer.importItems(items, { format, dryRun: true }) }
    },
    'import:run': async (e, file) => {
      const importer = require('../../../cli/import.js')
      const f = String(file || '')
      // Arbitrary-path read primitive sealed off: only the path most recently returned by the main-process dialog is accepted
      if (!lastPickedImportPath || f !== lastPickedImportPath) throw new Error('import: path not granted by picker')
      // same pipeline as importer.importFile, but the text->items parse runs in the worker thread
      const text = fs.readFileSync(f, 'utf8')
      const { format, items } = await runImportParse(text)
      if (!['ticktick', 'dida365', 'todoist'].includes(format)) {
        throw new Error(`unknown format "${format}" (valid: auto|ticktick|dida365|todoist)`)
      }
      const r = importer.importItems(items, { dryRun: false, format })
      // review P2 (2026-09-10): bulk import writes straight through the main process and bypassed the
      // todo-db:call audit hook — land one explicit line so app-side imports are traceable like CLI imports
      try { appAudit.recordCustom('import', ['import:run', f], [], [], 'imported ' + ((r && r.imported) || 0) + ' task(s)') } catch { /* best-effort */ }
      // 与 todo-db:call 写路径对齐(2026-09-09 P2):导入落库后必须刷新调度器并广播,否则应用内导入后
      // 主窗口列表陈旧、已导入的提醒全部静默丢失
      try { scheduler.reloadAll(dbApi()) } catch (err) { log.warn('[Import] reloadAll failed', err) }
      // 2026-09-10 P2:传 e.sender(IpcMainInvokeEvent 本身不是 webContents,exclude 永不命中,
      // 发起导入的窗会被自己的广播打断撤销栈);其余窗照常刷新
      broadcastTodosChanged('import', e.sender)
      return r
    }
  }
}
