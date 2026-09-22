/** Todo list Excel export — moved from index.js with dependency injection */
const path = require('path')
const { app, dialog } = require('electron')

/** Expected data-column count for the export sheet (A..Q). Exported for tests. */
const EXPECTED_EXPORT_COLS = 17

/** D6 P2 (2026-09-22) hardened header parse: the previous inline `split(',')` + length throw ran
 *  AFTER the save dialog and produced a bare "exportCols must have 17 columns" on any translator
 *  comma. Now: cells are trimmed, the count is validated with a translator-actionable error, and
 *  empty cell names (a stray comma makes one) are rejected too. Pure — exported for unit tests.
 *  The caller must run this BEFORE showing the save dialog so a broken translation never pops UI. */
function parseExportColumns (raw, expected = EXPECTED_EXPORT_COLS) {
  const head = String(raw == null ? '' : raw).split(',').map(s => s.trim())
  if (head.length !== expected) {
    throw new Error('export column header must have ' + expected + ' columns, got ' + head.length +
      ' (the exportCols translation likely contains an unescaped comma)')
  }
  const empty = head.findIndex(h => !h)
  if (empty !== -1) {
    throw new Error('export column header has an empty name at position ' + (empty + 1) +
      ' (the exportCols translation likely contains a stray comma)')
  }
  return head
}

function createExporter ({ getMainWindow, i18n, log }) {
  async function exportTodosToXlsx ({ fileName, rows }) {
    // Header validation FIRST: a translator comma used to surface only after the user had already
    // been shown a save dialog (and the failure landed as a generic { error } result).
    const head = parseExportColumns(i18n.mt('exportCols'))
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
      const c1 = ws.getCell('A1'); c1.value = i18n.mt('exportSheetTitle'); c1.font = { size: 15 }; c1.alignment = { horizontal: 'center' }
      ws.mergeCells('A1:Q1')
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

module.exports = { createExporter, parseExportColumns, EXPECTED_EXPORT_COLS }
