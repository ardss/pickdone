/** CSV import IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const i18nM = require('../i18n')
const fixUtil = require('../fix-util')
const scheduler = require('../scheduler')
const appAudit = require('../audit')

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
      const format = importer.detectFormat(text)
      const items = importer.rowsToItems(text, format)
      return { file, report: importer.importItems(items, { format, dryRun: true }) }
    },
    'import:run': (e, file) => {
      const f = String(file || '')
      // Arbitrary-path read primitive sealed off: only the path most recently returned by the main-process dialog is accepted
      if (!lastPickedImportPath || f !== lastPickedImportPath) throw new Error('import: path not granted by picker')
      const r = require('../../../cli/import.js').importFile(f, { dryRun: false })
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

