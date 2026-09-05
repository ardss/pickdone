/** Todo list Excel export — moved from index.js with dependency injection */
const path = require('path')
const { app, dialog } = require('electron')

function createExporter ({ getMainWindow, i18n, log }) {
  async function exportTodosToXlsx ({ fileName, rows }) {
    const win = getMainWindow()
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: i18n.mt('exportTitle'),
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { canceled: true }
    try {
      const ExcelJS = require('exceljs')
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Sheet1')
      const head = i18n.mt('exportCols').split(',')
      if (head.length !== 15) throw new Error('exportCols must have 15 columns, got ' + head.length)
      const c1 = ws.getCell('A1'); c1.value = i18n.mt('exportSheetTitle'); c1.font = { size: 15 }; c1.alignment = { horizontal: 'center' }
      ws.mergeCells('A1:O1')
      ws.addRow(head)
      // Formula-injection escaping: strings starting with =+-@ or tab/CR are treated as formulas by Sheets/LibreOffice (DDE data exfiltration); a leading ' neutralizes them.
      // Leading whitespace is consumed first (" =" bypass). (Never put raw control characters into a source-level regex: it once caused an Unterminated regex that crashed startup)
      const safeCell = v => (typeof v === 'string' && /^\s*[=+\-@\t\r]/.test(v)) ? "'" + v : v
      rows.forEach(r => ws.addRow(r.map(safeCell)))
      ws.getColumn(1).width = 30.7109375
      await wb.xlsx.writeFile(filePath)
      log.info('[Export] done:', filePath, rows.length + ' rows')
      return { canceled: false, filePath }
    } catch (e) {
      log.error('[Export] failed:', e)
      return { canceled: false, error: e.message }
    }
  }
  return { exportTodosToXlsx }
}

module.exports = { createExporter }
