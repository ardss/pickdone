/**
 * CLI audit log — append-only record of external (AI/terminal) write operations
 *
 * Purpose: every change the AI makes is traceable forever. Each CLI write command appends one JSONL line:
 *   { ts, time, actor:'cli', action, argv, targets, changes, note }
 *   before/after inside changes are semantic-field snapshots (large fields like image/4 attachments excluded).
 * The file lives in the data directory as cli-audit.jsonl, rotating to .1 past 5MB; audit write failures never block business operations.
 */
const path = require('path')
const fs = require('fs')
const dayjs = require('dayjs')

const MAX_BYTES = 5 * 1024 * 1024

// Semantic fields kept in snapshots (enough to answer "what did the AI change last step"; attachments and other large fields excluded)
const SNAPSHOT_FIELDS = [
  'taskContent', 'taskDescribe', 'complete', 'completedAt', 'todoTime', 'reminderTime',
  'reminderOffsets', 'reminderExtra', 'dayStart', 'deletedAt', 'priority', 'deadlineTs', 'important', 'urgent',
  'categoryId', 'repeatId', 'subtasks', 'delete', 'status', 'updateTime'
]

function auditFile () {
  // Lazy require: lib.js also requires this module at top level (bidirectional); synchronous destructuring would get incomplete exports at load time
  const { userDataDir } = require('./lib')
  return path.join(userDataDir(), 'cli-audit.jsonl')
}

function snapshot (t) {
  if (!t) return null
  const o = {}
  for (const k of SNAPSHOT_FIELDS) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') o[k] = t[k]
  }
  return Object.keys(o).length ? o : null
}

// The raw command line of this process (injected by the pickdone CLI entry), persisted to enable replaying the whole invocation
let context = { argv: [] }
function setContext (argv) { context = { argv: [...argv] } }

/** Record one audit entry. action looks like add/edit/done/undo/delete/restore/purge/subtask */
function record ({ action, targets = [], changes = [], note }) {
  try {
    const file = auditFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const st = fs.statSync(file)
      if (st.size > MAX_BYTES) {
        const rolled = file + '.1'
        if (fs.existsSync(rolled)) fs.unlinkSync(rolled)
        fs.renameSync(file, rolled)
      }
    } catch (e) { /* no file on first write */ }
    const entry = {
      ts: Date.now(),
      time: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      actor: 'cli',
      action,
      argv: context.argv,
      targets: targets.filter(Boolean).map(t => ({ taskId: t.taskId, content: t.content != null ? t.content : t.taskContent })),
      changes: (changes || []).filter(c => c && (c.before || c.after)).map(c => ({
        taskId: c.taskId || (c.after && c.after.taskId) || (c.before && c.before.taskId),
        before: snapshot(c.before),
        after: snapshot(c.after)
      })),
      note: note || undefined
    }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch (e) { /* audit failure never affects business writes */ }
}

/** Read the most recent n entries (default 50). action can filter; corrupt rows are kept as raw without aborting */
function readEntries ({ n = 50, action } = {}) {
  const file = auditFile()
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let out = lines.map(l => {
    try { return JSON.parse(l) } catch { return { parseError: true, raw: l.slice(0, 200) } }
  })
  if (action) out = out.filter(e => e.action === action)
  return out.slice(-n)
}

module.exports = { setContext, record, readEntries, auditFile, dataDir: () => require('./lib').userDataDir() }
