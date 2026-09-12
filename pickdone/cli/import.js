/**
 * CSV import engine — one-time migration from other to-do apps (TickTick / dida365 / Todoist).
 * Parsers are written against the vendors' real export column layouts (research notes: docs/导入功能调研-*.md, Chinese-named files on disk):
 *   TickTick backup v3.0 (14 cols, leading "Date:"/"Version: 3.0" meta lines)
 *   dida365 backup (25-col superset: Folder Name/Tags/taskId/parentId, "Is Check list" with a space)
 *   Todoist backup/import template (TYPE,CONTENT,PRIORITY,INDENT,...)
 * Write path reuses lib.js/db.js row semantics (same shape as addTodo); dedup key = trimmed content + dayStart,
 * so re-importing the same file twice is a no-op. Everything is previewable via --dry-run.
 */
const dayjs = require('dayjs')
const core = require('../src/main/core/todo-core.js')

class ImportError extends Error {
  constructor (message, code = 'IMPORT_ERROR') { super(message); this.code = code }
}

/* ================= CSV parsing (RFC 4180: quoted fields, "" escapes, CRLF) ================= */
function parseCsv (text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // BOM
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row) // drop blank lines
      row = []
    } else field += c
  }
  row.push(field)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}

/** header row → lookup by lowercase trimmed name (TickTick and dida both quote headers) */
function headerMap (row) {
  const m = {}
  row.forEach((h, i) => { m[String(h).trim().toLowerCase()] = i })
  return m
}
const cell = (row, m, name) => {
  const i = m[name]
  return i == null ? '' : String(row[i] == null ? '' : row[i]).trim()
}

/* ================= format detection ================= */
function detectFormat (text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '')
  if (!lines.length) throw new ImportError('file is empty', 'EMPTY_FILE')
  const head = lines.slice(0, 3).join('\n').toLowerCase()
  if (/^version:\s*3\.0/m.test(head) || /"list name"/.test(head)) {
    return /"folder name"|"is check list"|\bparentid\b|"kind"/.test(head) ? 'dida365' : 'ticktick'
  }
  if (/^type\s*,\s*content\s*,\s*priority\s*,\s*indent/i.test(lines[0])) return 'todoist'
  throw new ImportError(
    'cannot recognize the CSV format (supported: TickTick backup, dida365 backup, Todoist template). ' +
    'Pass --format ticktick|dida365|todoist if the header is non-standard.', 'FORMAT_UNKNOWN')
}

/* ================= value normalizers ================= */
const DATE_FORMATS = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY/MM/DD HH:mm', 'YYYY-MM-DD', 'YYYY/MM/DD', 'MM/DD/YYYY HH:mm', 'MM/DD/YYYY']
function parseCsvDate (s) {
  if (!s) return 0
  const v = dayjs(s, DATE_FORMATS, true)
  if (v.isValid()) return +v
  const iso = dayjs(s) // ISO 8601 fallback (TickTick sometimes exports with a timezone suffix)
  return iso.isValid() ? +iso : 0
}

/** priority → our numeric scale (0 none / 1 low / 2 mid / 3 high; the UI exposes only high/low two tiers) */
function normPriority (raw, scale) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s || s === 'none' || s === '0') return 0
  if (scale === 'todoist') { const n = parseInt(s, 10); return n === 4 ? 3 : n === 3 ? 2 : n === 2 ? 1 : 0 }
  // ticktick/dida: 1=low 3=medium 5=high (or the words high/medium/low)
  if (s === 'high' || s === '5') return 3
  if (s === 'medium' || s === '3') return 2
  if (s === 'low' || s === '1') return 1
  return 0
}

/* ================= per-format rows → normalized items ================= */
/** item: { list, title, notes, tags, due, reminder, priority, done, completedAt, subs[] } */
function rowsToItems (text, format) {
  const rows = parseCsv(text)
  // TickTick backups lead with two meta lines ("Date: …" / "Version: 3.0") — locate the real header row first
  const hi = rows.findIndex(r => {
    const j = r.join(',').toLowerCase()
    return j.includes('list name') || j.includes('indent')
  })
  if (hi < 0 || rows.length <= hi + 1) throw new ImportError('CSV has a header but no data rows', 'EMPTY_FILE')
  const m = headerMap(rows[hi])
  const items = []
  if (format === 'todoist') {
    let lastTask = null
    for (const r of rows.slice(hi + 1)) {
      const type = cell(r, m, 'type').toLowerCase() || 'task'
      const content = cell(r, m, 'content')
      if (!content) continue
      const indent = parseInt(cell(r, m, 'indent'), 10) || 1
      // Completion column passthrough (same as the dida/TickTick path): Todoist exports use "checked" (x/1/true/yes = done)
      const checkedRaw = cell(r, m, 'checked').toLowerCase()
      const checked = ['x', '1', 'true', 'yes'].includes(checkedRaw)
      if (type === 'note') { // note rows belong to the preceding task (Todoist CSV has no note column)
        if (lastTask) lastTask.notes = (lastTask.notes ? lastTask.notes + '\n' : '') + content
        continue
      }
      const dateRaw = cell(r, m, 'date')
      const item = {
        list: '', title: content, notes: '', tags: [],
        due: dateRaw ? parseCsvDate(dateRaw) : 0,
        reminder: 0, done: checked, completedAt: 0,
        priority: normPriority(cell(r, m, 'priority'), 'todoist')
      }
      if (indent >= 2 && lastTask) { // INDENT 2..n = subtasks (we support one level; deeper ones are flattened)
        const subs = lastTask.subs || (lastTask.subs = [])
        subs.push({ text: content, checked })
        continue
      }
      items.push(item)
      lastTask = item
    }
    return items
  }
  // ticktick / dida365 share the column family (dida is a superset)
  const byTaskId = {}
  const all = []
  for (const r of rows.slice(hi + 1)) {
    const title = cell(r, m, 'title')
    if (!title) continue
    const status = cell(r, m, 'status')
    const item = {
      list: cell(r, m, 'list name'),
      title,
      notes: cell(r, m, 'content'),
      tags: cell(r, m, 'tags') ? cell(r, m, 'tags').split(/[,，;；]/).map(t => t.trim()).filter(Boolean) : [],
      due: parseCsvDate(cell(r, m, 'due date')) || parseCsvDate(cell(r, m, 'start date')),
      reminder: parseCsvDate(cell(r, m, 'reminder')),
      priority: normPriority(cell(r, m, 'priority'), 'ticktick'),
      done: status === '1' || status === '2',
      completedAt: parseCsvDate(cell(r, m, 'completed time'))
    }
    all.push(item)
    const tid = cell(r, m, 'taskid')
    if (tid) byTaskId[tid] = item
    const pid = cell(r, m, 'parentid')
    if (pid) item.parentKey = pid
  }
  // dida365: parent/child via parentId (Kind=checklistitem rows also hang off their parent).
  // The plain TickTick template has no hierarchy column → all rows import as flat tasks.
  const roots = []
  for (const it of all) {
    const parent = it.parentKey && byTaskId[it.parentKey]
    if (parent && parent !== it) (parent.subs = parent.subs || []).push({ text: it.title, checked: it.done })
    else roots.push(it)
  }
  return roots
}

/* ================= dedup + write ================= */
function dedupKeyOf (t) {
  return (t.taskContent || '').trim() + '|' + (t.dayStart || 0)
}

/**
 * Import normalized items. dryRun=true returns the report without writing anything.
 * Report: { format, total, imported, duplicates, skipped, categoriesCreated, tasks:[{title, action, reason?}] }
 */
function importItems (items, { dryRun = false, format, category = null, useLists = true } = {}) {
  const lib = require('./lib')
  const db = lib.open()
  const row = db.call('queryTodos', { deleted: 0, limit: 1 })[0] || db.call('queryTodos', { deleted: 1, limit: 1 })[0]
  const userId = row ? row.userId : 0

  // Fingerprint pool of existing tasks (live + recycle bin): importing the same file twice must not double-insert
  const existing = new Set()
  for (const t of db.call('queryTodos', { deleted: 0 })) existing.add(dedupKeyOf(t))
  for (const t of db.call('queryTodos', { deleted: 1 })) existing.add(dedupKeyOf(t))

  const fixedCategoryId = category != null ? lib.resolveCategory(category) : null
  const catCache = new Map()
  const createdCats = []
  const resolveCat = name => {
    if (catCache.has(name)) return catCache.get(name)
    const hit = db.call('getAllCategories').find(c => (c.categoryName || '') === name)
    if (hit) { catCache.set(name, hit.categoryId); return hit.categoryId }
    if (dryRun) return 0 // preview must not create categories either
    const id = Date.now() + createdCats.length + 1 // numeric id, same family as the renderer's nextId()
    db.call('upsertCategory', {
      id, userId, name,
      color: ['#0f9d8f', '#4076C4', '#519A54', '#7E57C2', '#e8543f', '#D9982F', '#2f8fbb', '#b85c8f'][createdCats.length % 8],
      createdAt: Date.now(), sort: 100 * (createdCats.length + 1), isFolder: 0, parentId: 0, deleted: 0
    })
    createdCats.push(name)
    catCache.set(name, id)
    return id
  }

  const report = { format, total: items.length, imported: 0, wouldImport: 0, duplicates: 0, skipped: 0, categoriesCreated: createdCats, tasks: [] }
  const pending = []
  // dayStart cache: repeated due timestamps (very common in vendor exports) must not re-run dayjs per row
  const dayStartCache = new Map()
  const dayStartOf = due => {
    if (dayStartCache.has(due)) return dayStartCache.get(due)
    const v = due ? +dayjs(due).startOf('day') : 0
    dayStartCache.set(due, v)
    return v
  }
  for (const it of items) {
    const title = String(it.title || '').trim()
    if (!title) { report.skipped++; report.tasks.push({ title: it.title, action: 'skipped', reason: 'empty title' }); continue }
    const dayStart = dayStartOf(it.due)
    const key = title + '|' + dayStart
    if (existing.has(key)) { report.duplicates++; report.tasks.push({ title, action: 'duplicate' }); continue }
    existing.add(key) // identical rows inside one file are deduped too
    const categoryId = fixedCategoryId != null ? fixedCategoryId
      : useLists && it.list ? resolveCat(it.list) : 0
    pending.push({ it, title, dayStart, categoryId })
    report.wouldImport++
    report.tasks.push({ title, action: 'create', list: it.list || null, due: dayStart ? dayjs(dayStart).format('YYYY-MM-DD') : null, subtasks: (it.subs || []).length })
  }

  if (dryRun || !pending.length) return report

  const audit = require('./audit')
  // H7 (2026-09-12 P1): the write loop used to call queryTodos for EVERY row to recompute the day's
  // min taskSort — an O(N²) full-table scan that made ten-thousand-row imports take minutes. Build a
  // dayStart → nextSort snapshot pool ONCE and decrement it per insert (preserves the top-insert
  // min-100 chain semantics exactly, including "empty day → sort 0").
  const dayNextSort = new Map()
  for (const x of db.call('queryTodos', { deleted: 0 })) {
    if (x.taskSort == null) continue
    const day = x.dayStart || 0
    const cur = dayNextSort.get(day)
    if (cur === undefined || x.taskSort < cur) dayNextSort.set(day, x.taskSort)
  }
  // H7 (2026-09-12 P1): rows now land through the transactional upsertMany op (db.transaction in db.js)
  // instead of per-row upsert — a crash mid-import used to leave a half-imported database with no audit
  // line; now the whole batch commits atomically (all-or-nothing).
  const now = Date.now()
  const rows = pending.map(({ it, title, dayStart, categoryId }, i) => {
    const ts = now + i
    const prevMin = dayNextSort.get(dayStart)
    const taskSort = prevMin === undefined ? 0 : Math.fround(prevMin - 100)
    // Always write back, including the first row of an empty day (sort=0): otherwise every row of
    // that day stays at 0 (parallel tie instead of the historical 0/-100/-200 top-insert chain)
    dayNextSort.set(dayStart, taskSort)
    // Completed tasks without a source completion timestamp fall back to the due date (then createTime):
    // stamping every row with "import moment" inflated the import day's done stats
    const completedAt = it.done ? (it.completedAt || it.due || ts) : 0
    return {
      complete: !!it.done,
      completedAt,
      createTime: ts, delete: false,
      reminderTime: it.reminder || 0, reminderOffsets: [], reminderExtra: [],
      estimate: 0, difficulty: 0,
      priority: it.priority || 0, deadlineTs: 0, important: 0, urgent: 0,
      repeatId: null, // repeat rules are NOT auto-created (vendor RRULE dialects differ); imported as plain tasks
      subtasks: it.subs && it.subs.length ? JSON.stringify(it.subs.map(s => ({ text: s.text, checked: !!s.checked }))) : null,
      image: null, files: null,
      categoryId: categoryId || 0,
      updateTime: ts, syncTime: 0,
      taskContent: title,
      taskDescribe: it.notes || '',
      taskId: core.genTaskId(userId, ts),
      taskSort,
      todoTime: it.due || 0,
      userId, status: 'add', version: 0
    }
  })
  db.call('upsertMany', rows)
  const createdRows = rows.map(r => db.call('getById', r.taskId))
  report.imported = rows.length
  audit.record({
    action: 'import',
    targets: createdRows.slice(0, 50),
    note: `imported ${report.imported} task(s) from ${format} CSV (duplicates ${report.duplicates}, skipped ${report.skipped}` +
      (createdCats.length ? `, categories created: ${createdCats.join('/')}` : '') + ')'
  })
  return report
}

/** Full pipeline: read file → detect → parse → import. Used by the CLI command. */
function importFile (file, opts = {}) {
  const fs = require('fs')
  if (!fs.existsSync(file)) throw new ImportError(`file not found: ${file}`, 'FILE_NOT_FOUND')
  const text = fs.readFileSync(file, 'utf8')
  const format = opts.format && opts.format !== 'auto' ? opts.format : detectFormat(text)
  if (!['ticktick', 'dida365', 'todoist'].includes(format)) {
    throw new ImportError(`unknown format "${format}" (valid: auto|ticktick|dida365|todoist)`, 'USAGE')
  }
  const items = rowsToItems(text, format)
  return importItems(items, { ...opts, format })
}

module.exports = { parseCsv, detectFormat, rowsToItems, importItems, importFile, ImportError, dedupKeyOf }
