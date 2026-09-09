#!/usr/bin/env node
/**
 * Todo CLI —— unified task management entry for AI agents and terminal users.
 * Usage: node cli/pickdone.js <command> [args] [options]
 * Human-readable output by default; --json for structured results (AI consumption).
 * All reads/writes go through lib.js (SQLite); a running App auto-refreshes via
 * DB file watching — no restart needed. CLI output is English-only by design:
 * the primary consumer is AI agents, so it stays locale-independent.
 */
const lib = require('./lib.js')
const importer = require('./import.js')
const dayjs = require('dayjs')
const fs = require('fs')
const path = require('path')
// Single source: the App package version (CLI ships inside the same package)
const CLI_VERSION = require('../package.json').version
const RELEASES_API = 'https://api.github.com/repos/ardss/pickdone/releases/latest'

// Audit context: inject raw argv so every write lands one audit line
lib.audit.setContext(process.argv.slice(2))

/* ================= arg parsing ================= */
function parseArgs (argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--done') opts.done = true
    else if (a === '--undone') opts.done = false
    else if (a === '--no-date') opts.noDate = true
    else if (a === '--all') opts.all = true
    else if (a === '--yes') opts.yes = true
    else if (a === '--force') opts.force = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++ } else opts[key] = true
    } else opts._.push(a)
  }
  return opts
}

const HELP = `PickDone CLI — unified task management for humans and AI agents

Usage: node cli/pickdone.js <command> [args] [options]

Read commands:
  overview                        today/overdue/no-date/recycle summary
  list   [range|--all]            list tasks (default: today)
        range: today (default) tomorrow week overdue future
        filters: --done --undone --no-date --category <name|id> --keyword <word>
        --quad q1|q2|q3|q4               four-quadrant filter (q1 important+urgent, q2 important, q3 urgent, q4 neither)
        --on <date>                      what's scheduled on one specific day, with times (scheduling view)
  search <keyword>                search by content/description
  get    <taskId|keyword>         show full fields of one task
  categories                      list categories
  category add <name> [--color hex] [--parent <folder>]   create a category (names stay unique)
  category rename <name|id> <newName>                     rename a category
  category rm <name|id> [--yes]   soft-delete a category (--dry-run to preview; tasks kept, recoverable in App)
  tag    [list]                   list tags (derived from #tag in titles/descriptions)
  tag rename <old> <new>          rewrite #old → #new across all tasks
  tag rm <name>                   strip a tag from all tasks
  projects                        list projects (progress/focus minutes/overdue/next 7 days)
  project <name|id> [--on|--off] [--deadline date|none]  details / set project / set deadline (days-left warn)
  milestone <project> [list|add <title> <date>|rm <n>|link <n> <task>|unlink <n> <task>]   project milestones (date: YYYY-MM-DD/MM-DD/today/+14d)
  stats  [--from YYYY-MM-DD --to YYYY-MM-DD]  daily done/focus stats (default: last 7 days)
  recycle                         list recycle bin
  plan   [list] [date]            show schedule chips for a day (default: today)
  plan set <taskId|keyword> <HH:mm> [--date D] [--replace]   put a task on the day timeline at HH:mm
  plan rm <taskId|keyword> [--at HH:mm] [--date D]           remove a chip (--at targets one chip; default clears the task's chips that day)
  settings [list|get <key>]       list all known settings with current values
  settings set <key> <value>      change a setting (e.g. backupDir "D:\\backups", colorMode dark, dailyTomatoTarget 10; running App applies within ~2s; protected keys like lock password are rejected)
  log    [--n 20] [--action x]    external write audit trail (every AI change is traceable)

Write commands:
  add    <content> [--desc text] [--date today|tomorrow|+3d|YYYY-MM-DD[ HH:mm]] [--created-at "YYYY-MM-DD HH:mm"]
         [--reminder same as date] [--category name] [--difficulty 0-3] [--estimate 0-20]
  done   <taskId|keyword>         complete a task (--no-sub-cascade to skip subtasks; --at "YYYY-MM-DD HH:mm" backdates completedAt)
  undo   <taskId|keyword>         undo completion
  edit   <taskId|keyword> [--content text] [--desc text] [--date value] [--reminder value] [--remind-offset "10,30"|none] [--remind-extra "D HH:mm,..."|none] [--category name] [--important 0|1] [--urgent 0|1] [--priority 0-3] [--difficulty 0-3] [--deadline date|none] [--estimate 0-20]
         --remind-offset: minutes BEFORE the main reminder (needs --reminder set); --remind-extra: extra absolute datetimes
  sort   <taskId|keyword> top|up|down|bottom|before <task2>|after <task2>   manual order (scoped to the task's own day; edit --date first to co-locate)
  deps  <task> list|add|rm [predTask]   explicit dependency edges (FS semantics: task is ready when all predecessors are done)
  ready [--project <name|id>]            undone tasks with all predecessors complete — "what can I do next"
  import <file.csv> [--format auto|ticktick|dida365|todoist] [--dry-run]
         [--category <name>] [--no-lists]      migrate from another app (list names become categories by default)
  delete <taskId|keyword>         move to recycle bin
  restore <taskId|keyword>        restore from recycle bin
  purge  [--dry-run] --yes        empty recycle bin (irreversible; --dry-run to preview)
  subtask <add|check|uncheck|rm|move> <task> [n|text]   subtask management (move: subtask move <task> <n> up|down|top|bottom|to <m>)
  attachment add <task> <file...>   attach files to a task (50MB max, ext whitelist; images vs files auto-sorted)
  attachment list <task>            list a task's attachments
  attachment rm <task> img|file <n> remove the n-th attachment (n from attachment list)
  repeat on <task> [--type daily|weekly|monthly|yearly] [--interval N] [--weekdays 1,3,5] [--monthday D] [--count N] [--skip-weekends] [--skip-holidays]
  repeat off <task> [--all]        leave repeat group (--all also removes future instances); repeat rule <task> to inspect
  tomato status                          tomato status (running?/seconds left/attached task/today count)
  events import --file <events.json>   rebuild a schedule from a structured event JSON array (idempotent; each event = task + backdated done + linked focus record)
  tomato list [--date today|yesterday|YYYY-MM-DD] [<task|keyword>] [--n 30]   query focus records (read-only, works without the App)
  tomato start [--task <taskId|keyword>] [--minutes N]   start focus (can attach a task; errors if App not running)
  tomato stop [--reason text] [--no-record]             stop/give up (records by focused minutes by default, --no-record skips)
  tomato attach <taskId|keyword|--none>    attach/detach tomato task (does not interrupt a running focus)
  tomato backfill <taskId|keyword|--free> [--date today|YYYY-MM-DD] [--minutes 25] [--at HH:mm]
                                  retro-log a focus session to a task/date (manual record, counts into actual pomodoros; works without the App — direct ledger row write)
  tomato record fix <tomatoId|prefix> [--minutes N] [--date D --at HH:mm] [--rest N] [--succeed yes|no] [--task <kw|--free>]
                                  fix an existing focus record (wrong duration/time/task; works without the App)
  tomato record rm <tomatoId|prefix>   delete an erroneous focus record (irrecoverable; tomato list to browse ids; works without the App)
  open   [--dev]                  launch App (brings existing window to front if already running)
  doctor                          environment self-check (data dir/driver/rw scale)
  clean  [--all] [--dry-run]      clean regenerable test/dev residue in %TEMP% (never touches real user data)
  restore-backup [path]           list auto snapshots (userData/backups) or validate one and show how to restore (read-only, never touches the DB)

Global options:
  --json   structured output (recommended for AI; write responses include a next suggestions field)
  --limit N  list/search result cap (default 200, max 500, protects context)
Version & updates:
  version                         show CLI/App version (--version / -v also work; --json for structured output)
  update                          check GitHub for a newer release (installing stays in the App's updater)
Skills (AI agent integration):
  skill install                   install the PickDone SKILL.md into the local skill dirs
                                  (~/.zcode, ~/.claude and ~/.cursor skill dirs), so coding
                                  agents discover how to drive this CLI. Re-run after App updates.
  -h       help

Environment:
  TODO_DB_DIR         data directory override, contains todos.db directly (default %APPDATA%/pickdone, for test isolation)
  TODO_USER_DATA_DIR  main-process isolation var (userData root); used by the CLI when TODO_DB_DIR is unset`

/* ================= formatting ================= */
const NO_DATE = 'no date'
function fmtDay (t) {
  if (!t.dayStart && !t.todoTime) return NO_DATE
  return dayjs(t.todoTime || t.dayStart).format('MM-DD HH:mm').replace(' 00:00', '')
}
function fmtTodoLine (t) {
  const mark = t.complete ? '[x]' : '[ ]'
  const due = fmtDay(t)
  const parts = [mark, t.taskContent]
  if (t.taskDescribe) parts.push('— ' + t.taskDescribe.split('\n')[0].slice(0, 40))
  if (t.reminderTime) parts.push('⏰' + dayjs(t.reminderTime).format('MM-DD HH:mm'))
  if (due !== NO_DATE) parts.push('(' + due + ')')
  return parts.join('  ')
}
function fmtCat (c) { return `${c.categoryId}\t${c.categoryName}${c.categoryColor ? '\t' + c.categoryColor : ''}` }

/** audit changes summary: list changed semantic fields (before→after) */
const FIELD_LABEL = { taskContent: 'title', taskDescribe: 'desc', complete: 'complete', completedAt: 'completedAt', todoTime: 'date', reminderTime: 'reminder', categoryId: 'category', repeatId: 'repeatGroup', subtasks: 'subtasks', delete: 'delete', status: 'status' }
const ts = v => (typeof v === 'number' && v > 1e11) ? dayjs(v).format('MM-DD HH:mm') : v
function summarizeChanges (changes) {
  const parts = []
  for (const c of changes || []) {
    const keys = new Set([...Object.keys(c.before || {}), ...Object.keys(c.after || {})])
    const diffs = []
    for (const k of keys) {
      const b = c.before ? c.before[k] : undefined
      const a = c.after ? c.after[k] : undefined
      if (JSON.stringify(b) !== JSON.stringify(a)) diffs.push(`${FIELD_LABEL[k] || k}: ${ts(b) ?? '∅'} → ${ts(a) ?? '∅'}`)
    }
    if (diffs.length) parts.push(diffs.join(', '))
    else if (!c.before && c.after) parts.push('created')
    else if (c.before && !c.after) parts.push('purged')
  }
  return parts.join(' | ')
}

function fail (e, command) {
  // The error envelope mirrors the success side {ok:true,command,data}: AI parsers need one judgment path, not two
  const base = { ok: false, command: command || null }
  if (e instanceof lib.CliError) {
    console.error(JSON.stringify({ ...base, error: e.code, message: e.message }))
  } else {
    console.error(JSON.stringify({ ...base, error: 'INTERNAL', message: String(e && e.message || e) }))
  }
  process.exit(1)
}

/* ================= command dispatch ================= */
async function main () {
  const argv = process.argv.slice(2)
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) { console.log(HELP); return }
  if (['--version', '-v', 'version'].includes(argv[0])) {
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: true, command: 'version', data: { version: CLI_VERSION } }, null, 2))
    else {
      console.log(`PickDone CLI v${CLI_VERSION} (matches the installed App version)`)
      console.log('run "update" to check GitHub for a newer release')
    }
    return
  }
  const cmd = argv[0]
  const opts = parseArgs(argv.slice(1))
  if (opts.help) { console.log(HELP); return }

  const WRITE_CMDS = ['add', 'edit', 'done', 'undo', 'delete', 'restore', 'subtask', 'repeat', 'events', 'deps'] // events 入列让 --dry-run 真预览(原为死分支:永远真跑)
  const dry = !!opts['dry-run'] && WRITE_CMDS.includes(cmd)
  const emit = data => {
    if (opts.json) console.log(JSON.stringify({ ok: true, command: cmd, data }, null, 2))
    else console.log(data)
  }
  const emitNext = (data, next) => {
    if (opts.json) console.log(JSON.stringify({ ok: true, command: cmd, data, next }, null, 2))
    else console.log(data)
  }
  const emitList = rows => {
    if (opts.json) return emit(rows)
    if (!rows.length) return console.log('(no tasks)')
    console.log(rows.map(t => fmtTodoLine(t)).join('\n'))
    console.log(`-- ${rows.length} task(s)`)
  }
  const okMsg = (t, next) => {
    if (opts.json) console.log(JSON.stringify({ ok: true, command: cmd, data: t, next: next || [] }, null, 2))
    else {
      console.log('✓ ' + fmtTodoLine(t))
      console.log('  taskId: ' + t.taskId)
    }
  }

  switch (cmd) {
    /* ---- read ---- */
    case 'overview': {
      const d = lib.overview()
      if (opts.json) return emit(d)
      console.log(`Today: ${d.today.done}/${d.today.total} done`)
      console.log(`Overdue (undone): ${d.overdue}`)
      console.log(`No date: ${d.noDate}   Next 7 days: ${d.upcoming7days}`)
      console.log(`Completed total: ${d.completedTotal}   Recycle bin: ${d.recycleBin}   Categories: ${d.categories}`)
      return
    }
    case 'list': {
      const first = opts._[0]
      const range = ['today', 'tomorrow', 'week', 'overdue', 'future'].includes(first) ? first : (opts.all ? null : 'today')
      if (first && !range && !opts.all && !opts.on) throw new lib.CliError(`unknown range "${first}" (valid: today/tomorrow/week/overdue/future or --all or --on <date>)`)
      // --on <date>: what's scheduled on one specific day (with times) — the "what should I slot at 11am tomorrow" view
      if (opts.on != null && opts.on !== true) {
        const rows = lib.listOn(opts.on)
        if (opts.json) return emit(rows)
        if (!rows.length) return console.log('(nothing scheduled on ' + opts.on + ')')
        console.log(rows.map(t => `${t.time ? t.time : 'all-day'}  [${t.complete ? 'x' : ' '}] ${t.content}${t.tomatoEstimate ? '  (est ' + t.tomatoEstimate + '🍅)' : ''}`).join('\n'))
        console.log(`-- ${rows.length} task(s) on ${opts.on}`)
        return
      }
      // quadrants: q1=important&urgent q2=important q3=urgent q4=neither (same mapping as MatrixGrid)
      let quad = null
      if (opts.quad != null) {
        const q = String(opts.quad).toLowerCase().replace(/^q/, '')
        if (!['1', '2', '3', '4'].includes(q)) throw new lib.CliError('--quad accepts q1|q2|q3|q4', 'USAGE')
        quad = { important: q === '1' || q === '2' ? 1 : 0, urgent: q === '1' || q === '3' ? 1 : 0 }
      }
      emitList(lib.listTodos({
        range: quad ? null : range, done: opts.done === 'false' ? false : opts.done, noDate: opts.noDate,
        category: opts.category != null ? lib.resolveCategory(opts.category) : null,
        keyword: opts.keyword, limit: opts.limit, quad
      }))
      return
    }
    case 'search': {
      const kw = opts._[0]
      if (!kw) throw new lib.CliError('usage: search <keyword>', 'USAGE')
      emitList(lib.listTodos({ keyword: kw, done: opts.done === 'false' ? false : opts.done, range: opts.all ? null : undefined, limit: opts.limit }))
      return
    }
    case 'get': {
      if (!opts._[0]) throw new lib.CliError('usage: get <taskId|keyword>', 'USAGE')
      const t = lib.resolveTask(opts._[0])
      if (opts.json) return emit(t)
      console.log(JSON.stringify(t, null, 2))
      return
    }
    case 'categories': {
      const cats = lib.getCategories()
      if (opts.json) return emit(cats)
      console.log(cats.length ? cats.map(fmtCat).join('\n') : '(no categories)')
      return
    }
    /* ---- category CRUD: same SQLite categories table as the UI (upsertCategory), writes show up after ~2s db watch ---- */
    case 'category': {
      const [op, ...rest] = opts._
      if (op === 'add') {
        const name = rest[0]
        if (!name) throw new lib.CliError('usage: category add <name> [--color #0f9d8f|teal-palette-name] [--parent <folder>]', 'USAGE')
        const c = lib.addCategory(name, { color: opts.color !== true ? opts.color : undefined, parent: opts.parent !== true ? opts.parent : undefined })
        if (opts.json) return emit({ categoryId: c.categoryId, name: c.categoryName, color: c.categoryColor, parent: c.folderId }, ['add <task> --category "' + c.categoryName + '" to file tasks into it'])
        return console.log(`✓ category created: ${c.categoryName}  (id ${c.categoryId}, color ${c.categoryColor})`)
      }
      if (op === 'rename') {
        const [target, next] = rest
        if (!target || !next) throw new lib.CliError('usage: category rename <name|id> <newName>', 'USAGE')
        const c = lib.renameCategory(target, next)
        if (opts.json) return emit({ categoryId: c.categoryId, name: c.categoryName })
        return console.log(`✓ renamed to "${c.categoryName}"`)
      }
      if (op === 'rm' || op === 'delete') {
        const target = rest[0]
        if (!target) throw new lib.CliError('usage: category rm <name|id> [--yes]  (soft delete — recoverable in App, tasks are kept)', 'USAGE')
        if (!opts.yes) {
          if (opts['dry-run'] || opts.dry) {
            const id = lib.resolveCategory(target)
            const c = lib.getCategories().find(x => x.categoryId === id)
            return console.log(`= dry run: would soft-delete "${c.categoryName}" (tasks kept, unfiled). Re-run with --yes.`)
          }
          throw new lib.CliError('category rm needs --yes after you confirmed with the user (soft delete, recoverable in App)', 'NEEDS_CONFIRM')
        }
        const r = lib.deleteCategory(target)
        if (opts.json) return emit(r)
        return console.log('✓ deleted: ' + r.deleted.map(v => v.name).join(', '))
      }
      throw new lib.CliError('unknown sub-operation "' + op + '" (valid: add/rename/rm; plain `categories` lists)', 'UNKNOWN_ARG')
    }
    /* ---- tags: derived from #tag in content/description; rename/rm rewrite text across all tasks ---- */
    case 'tag': {
      const [op, ...rest] = opts._
      if (!op || op === 'list') {
        const tags = lib.listTags()
        if (opts.json) return emit(tags)
        if (!tags.length) return console.log('(no tags — tags come from #tag in task titles/descriptions)')
        console.log(tags.map(t => `#${t.name}  ${t.tasks} task(s)`).join('\n'))
        return
      }
      if (op === 'rename') {
        const [oldName, next] = rest
        if (!oldName || !next) throw new lib.CliError('usage: tag rename <old> <new>  (rewrites #old → #new across all task titles/descriptions)', 'USAGE')
        const touched = lib.rewriteTag(String(oldName).replace(/^#/, ''), String(next).replace(/^#/, ''))
        if (opts.json) return emit({ from: oldName, to: next, tasks: touched })
        return console.log(`✓ #${String(oldName).replace(/^#/, '')} → #${String(next).replace(/^#/, '')} in ${touched} task(s)`)
      }
      if (op === 'rm' || op === 'delete') {
        const name = rest[0]
        if (!name) throw new lib.CliError('usage: tag rm <name>  (strips #name from all task titles/descriptions)', 'USAGE')
        const touched = lib.rewriteTag(String(name).replace(/^#/, ''), null, { remove: true })
        if (opts.json) return emit({ removed: name, tasks: touched })
        return console.log(`✓ #${String(name).replace(/^#/, '')} removed from ${touched} task(s)`)
      }
      throw new lib.CliError('unknown sub-operation "' + op + '" (valid: list/rename/rm)', 'UNKNOWN_ARG')
    }
    case 'projects': {
      const ps = lib.getProjects()
      if (opts.json) return emit(ps)
      if (!ps.length) return console.log('(no projects — use "set as project" in category manager, or project <category> --on)')
      console.log('Name\tProgress\tTasks\tFocus (min)\tOverdue\tNext 7 days\tStarted')
      ps.forEach(p => console.log(`${p.name}\t${p.progress}%\t${p.done}/${p.total}\t${p.focusMinutes}\t${p.overdue}\t${p.next7days}\t${p.startedAt ? dayjs(p.startedAt).format('YYYY-MM-DD') : '—'}`))
      return
    }
    case 'project': {
      const name = opts._[0]
      if (!name) throw new lib.CliError('usage: project <name|id> [--on|--off] [--deadline YYYY-MM-DD|none]; no flag shows details', 'USAGE')
      if (opts.on || opts.off) {
        const r = lib.setProjectFlag(name, !!opts.on)
        if (opts.json) return emit(r)
        return console.log(`✓ "${r.name}" ${r.isProject ? 'is now a project' : 'restored to plain category'}`)
      }
      if (opts.deadline !== undefined) {
        const r = lib.setProjectDeadline(name, opts.deadline)
        if (opts.json) return emit(r)
        return console.log(r.deadline ? `✓ "${r.name}" deadline → ${dayjs(r.deadline).format('YYYY-MM-DD')}` : `✓ "${r.name}" deadline cleared`)
      }
      const id = lib.resolveCategory(name)
      const c = lib.getCategories().find(x => x.categoryId === id)
      const p = lib.projectStatus(c)
      if (opts.json) return emit(p)
      const dl = p.deadline ? `   deadline ${dayjs(p.deadline).format('YYYY-MM-DD')} (${Math.ceil((p.deadline - Date.now()) / 864e5)} days left)` : ''
      console.log(`${p.name}  ${p.progress}%  (${p.done}/${p.total})${dl}`)
      console.log(`Started ${p.startedAt ? dayjs(p.startedAt).format('YYYY-MM-DD') : '—'}   Focus ${p.focusMinutes} min   Overdue ${p.overdue}   Next 7 days ${p.next7days}`)
      const list = lib.listTodos({ category: id, limit: 100 })
      console.log(list.length ? '\n' + list.map(t => fmtTodoLine(t)).join('\n') : '\n(no tasks)')
      return
    }
    case 'milestone': {
      const [name, op, ...rest] = opts._
      if (!name) throw new lib.CliError('usage: milestone <project> [list | add <title> <date> | rm <n>]', 'USAGE')
      if (!op || op === 'list') {
        const { milestones } = lib.getMilestones(name)
        const pid = lib.resolveCategory(name)
        const tasks = lib.listTodos({ category: pid, limit: 500, done: null }).filter(t => !t.delete)
        if (opts.json) return emit(milestones.map(m => ({ ...m, progress: lib.msProgress(m, tasks) })))
        if (!milestones.length) return console.log('(no milestones)')
        const t0 = +dayjs().startOf('day')
        milestones.forEach((m, i) => {
          const state = m.date < t0 ? '✓past' : m.date === t0 ? '●today' : '○upcoming'
          const p = lib.msProgress(m, tasks)
          const prog = p ? `  progress ${p.pct}% (${p.done}/${p.total})` : ''
          console.log(`${i + 1}. [${state}] ${m.title}  ${dayjs(m.date).format('YYYY-MM-DD')}${prog}  linked tasks ${m.taskIds.length}`)
        })
        return
      }
      if (op === 'add') {
        const title = rest[0]
        const dateInput = rest.slice(1).join(' ')
        const r = lib.addMilestone(name, title, dateInput)
        if (opts.json) return emit(r)
        return console.log(`✓ milestone added: ${title} → ${dayjs(r.milestones[r.milestones.length - 1].date).format('YYYY-MM-DD')}`)
      }
      if (op === 'rm') {
        const r = lib.removeMilestone(name, rest[0])
        if (opts.json) return emit(r)
        return console.log(`✓ milestone removed: ${r.removed.title}`)
      }
      if (op === 'link' || op === 'unlink') {
        const r = lib.linkMilestone(name, rest[0], rest.slice(1).join(' '), op === 'link')
        if (opts.json) return emit(r)
        const p = r.progress
        return console.log(`✓ ${op === 'link' ? 'linked' : 'unlinked'} "${r.milestone.title}"${p ? `  progress ${p.pct}% (${p.done}/${p.total})` : ''}`)
      }
      throw new lib.CliError(`unknown sub-operation "${op}" (valid: list/add/rm/link/unlink)`, 'UNKNOWN_ARG')
    }
    case 'stats': {
      const d = lib.stats({ from: opts.from, to: opts.to })
      if (opts.json) return emit(d)
      console.log('Date\tDone/Total\tFocus (min)')
      d.forEach(r => console.log(`${r.day}\t${r.done}/${r.total}\t${r.focusMinutes}`))
      return
    }
    case 'recycle': {
      const rows = lib.recycleTasks()
      if (opts.json) return emit(rows)
      console.log(rows.length ? rows.map(t => `${t.taskContent}  (deleted at ${dayjs(t.updateTime).format('YYYY-MM-DD HH:mm')})`).join('\n') : '(recycle bin is empty)')
      return
    }
    case 'log': {
      const entries = lib.readAuditLog({ n: Math.min(parseInt(opts.n, 10) || 20, 200), action: opts.action })
      if (opts.json) return emit(entries)
      if (!entries.length) return console.log('(no audit entries)')
      console.log(entries.map(e => {
        const target = (e.targets || []).map(t => t.content).join('、') || (e.changes || []).map(c => {
          const s = c.before || c.after || {}
          return s.taskContent || ''
        }).join('、')
        const diff = summarizeChanges(e.changes)
        return `${e.time}  [${e.action}]  ${target}${diff ? '  ' + diff : ''}${e.note ? '  # ' + e.note : ''}`
      }).join('\n'))
      return
    }

    /* ---- write ---- */
    case 'add': {
      // Preview must match real semantics: without --date, addTodo creates a no-date task (not today) — this previously misled AI decisions
      if (dry) return emitNext({ dryRun: true, content: opts._.join(' '), date: opts.date || null, category: opts.category || null }, ['remove --dry-run to actually create'])
      const content = opts._.join(' ')
      const t = lib.addTodo({
        content, desc: opts.desc, date: opts.date, reminder: opts.reminder,
        category: opts.category, difficulty: opts.difficulty,
        priority: opts.priority != null && opts.priority !== true ? opts.priority : undefined,
        important: opts.important != null && opts.important !== true ? opts.important : undefined,
        urgent: opts.urgent != null && opts.urgent !== true ? opts.urgent : undefined,
        createTime: opts['created-at'] || null,
        after: opts.after != null && opts.after !== true ? [opts.after] : null
      })
      if (opts.estimate != null && opts.estimate !== true) lib.setEstimate(t.taskId, opts.estimate)
      const hints = [`get ${t.taskId} --json to verify`, `done ${t.taskId} to complete it`, 'list --json to read back']
      // No-date tasks land in the inbox (not the today list) — in practice even agents assume add=today, so an inline hint is mandatory
      if (!opts.date) {
        hints.push('NOTE: no --date given, task is in the inbox (not today); edit ' + t.taskId + ' --date today to schedule it')
        if (!opts.json) console.log('  ! no --date given: task went to the todo box (not on today list); run edit ' + t.taskId + ' --date today to schedule it')
      }
      return okMsg(t, hints)
    }
    case 'deps': {
      // deps <task> list|add|rm [pred] — explicit dependency edges (FS: all preds done -> task ready)
      const [target, verb, ...rest] = opts._
      const cur = lib.getTask(target)
      if (verb === 'list' || !verb) {
        const ids = lib.parsePredecessors(cur.predecessors)
        console.log('predecessors of [' + cur.taskContent + ']: ' + ids.length)
        for (const id of ids) {
          let p = null
          try { p = lib.getTask(id) } catch { }
          console.log('  ' + (p ? (p.complete ? '[x] ' : '[ ] ') : '[?] ') + (p ? p.taskContent : id) + (p ? '' : ' (missing)'))
        }
        return null
      }
      const pred = rest[0]
      if (!pred) throw new lib.CliError('deps ' + verb + ' needs a predecessor task id/keyword', 'USAGE')
      const pt = lib.getTask(pred)
      const curIds = lib.parsePredecessors(cur.predecessors)
      let next
      if (verb === 'add') {
        if (curIds.includes(pt.taskId)) return okMsg(cur, ['already a predecessor: ' + pt.taskContent])
        next = curIds.concat(pt.taskId)
      } else if (verb === 'rm') {
        next = curIds.filter(x => x !== pt.taskId)
      } else throw new lib.CliError('unknown deps verb: ' + verb + ' (use list|add|rm)', 'USAGE')
      const out = lib.patchTodo(cur.taskId, { predecessors: next }, { action: 'deps-' + verb })
      return okMsg(out, verb === 'add' ? 'pred set: ' + next.join(', ') : 'pred removed: ' + pt.taskContent)
    }
    case 'ready': {
      // ready [--project <name|id>] — undone tasks whose predecessors are all complete (or none); the "what can I do next" read
      const scope = opts.project != null && opts.project !== true ? lib.resolveCategory(opts.project) : null
      const items = lib.listReady(scope)
      console.log('ready: ' + items.length)
      for (const t of items.slice(0, 50)) console.log('  ' + t.taskContent + ' (' + t.taskId + ')')
      return null
    }
    case 'sort': {
      const [target, pos, ...rest] = opts._
      if (!target || !pos) throw new lib.CliError('usage: sort <taskId|keyword> top|up|down|bottom|before <task2>|after <task2>  (order is scoped to the task\'s own day; use edit --date first to co-locate)', 'USAGE')
      if (opts.json) {
        const r = lib.sortTask(target, pos, rest.join(' ') || undefined)
        return emit({ ...r, note: 'dayOrder shows ★ at the moved task' })
      }
      const r = lib.sortTask(target, pos, rest.join(' ') || undefined)
      console.log('✓ moved. day order now:')
      r.dayOrder.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
      return
    }
    case 'done': {
      if (!opts._[0]) throw new lib.CliError('usage: done <taskId|keyword>', 'USAGE')
      if (dry) return emitNext({ dryRun: true, taskId: lib.resolveTask(opts._[0]).taskId, would: 'complete (with subtask cascade / repeat renewal)' }, ['remove --dry-run to actually run'])
      const at = opts.at ? lib.parseDate(opts.at) : null // done --at "YYYY-MM-DD HH:mm": backdated completion for backfill/reconstruction
      // Only the explicit override reaches lib; absent flag defers to the isCompleteWithSubtasks setting (lib default)
      const r = lib.toggleComplete(opts._[0], true, { withSubtasks: opts['no-sub-cascade'] ? false : undefined, completedAt: at })
      if (opts.json) {
        // JSON contract: renewed always present (null when no renewal); smoke/agents rely on this field
        console.log(JSON.stringify({ ok: true, command: cmd, data: r.completed, renewed: r.renewed ?? null, next: ['undo ' + r.completed.taskId + ' to revert', 'stats --json to see today completions'] }, null, 2))
        return
      }
      if (r.renewed) console.log('↻ renewed next instance: ' + fmtTodoLine(r.renewed))
      return okMsg(r.completed, ['undo ' + r.completed.taskId + ' to revert', 'stats --json to see today completions'])
    }
    case 'undo': {
      if (dry) return emitNext({ dryRun: true, taskId: lib.resolveTask(opts._[0]).taskId, would: 'undo complete' }, ['remove --dry-run to actually run'])
      if (!opts._[0]) throw new lib.CliError('usage: undo <taskId|keyword>', 'USAGE')
      // Pass the explicit override through like `done` does; absent flag defers to the setting (lib default)
      return okMsg(lib.toggleComplete(opts._[0], false, { withSubtasks: opts['no-sub-cascade'] ? false : undefined }))

    }
    case 'edit': {
      if (dry) {
        const patch = {}
        if (opts.content) patch.taskContent = opts.content
        if (opts.date) patch.todoTime = lib.parseDate(opts.date)
        if (opts.important != null) patch.important = parseInt(opts.important, 10) ? 1 : 0
        if (opts.urgent != null) patch.urgent = parseInt(opts.urgent, 10) ? 1 : 0
        if (opts.priority != null) patch.priority = parseInt(opts.priority, 10)
        if (opts.deadline) patch.deadlineTs = opts.deadline === 'none' ? 0 : lib.parseDate(opts.deadline)
        return emitNext({ dryRun: true, taskId: lib.resolveTask(opts._[0]).taskId, patch }, ['remove --dry-run to actually run'])
      }
      if (!opts._[0]) throw new lib.CliError('usage: edit <taskId|keyword> [--content ..] [--desc ..] [--date ..] [--reminder ..] [--category ..] [--important 0|1] [--urgent 0|1] [--priority 0-3] [--deadline date|none] [--estimate 0-20] [--difficulty 0-3]', 'USAGE')
      const patch = {}
      if (opts.content) patch.taskContent = opts.content
      if (opts.desc) patch.taskDescribe = opts.desc
      if (opts.date !== undefined) patch.todoTime = lib.parseDate(opts.date)
      if (opts.reminder !== undefined) patch.reminderTime = lib.parseDate(opts.reminder)
      if (opts.category !== undefined) patch.categoryId = lib.resolveCategory(opts.category) || 0
      if (opts.important != null) patch.important = parseInt(opts.important, 10) ? 1 : 0
      if (opts.urgent != null) patch.urgent = parseInt(opts.urgent, 10) ? 1 : 0
      if (opts.priority != null) patch.priority = parseInt(opts.priority, 10)
      // priority ↔ important quadrant two-way coupling (same semantics as EditPanel fieldPatch / MatrixGrid drag, one ledger):
      // high(3)↔important=1, low/none↔important=0; whichever is explicitly specified wins
      if (opts.priority != null && opts.important == null) patch.important = parseInt(opts.priority, 10) === 3 ? 1 : 0
      if (opts.important != null && opts.priority == null) patch.priority = parseInt(opts.important, 10) ? 3 : 1
      if (opts.deadline) patch.deadlineTs = opts.deadline === 'none' ? 0 : lib.parseDate(opts.deadline)
      if (opts.difficulty != null && opts.difficulty !== true) patch.difficulty = parseInt(opts.difficulty, 10) || 0
      if (!Object.keys(patch).length && opts.estimate == null && opts['remind-offset'] == null && opts['remind-extra'] == null) throw new lib.CliError('edit requires at least one field')
      // Apply the main patch before reminder/tomato branches: with --reminder + --remind-offset in one command, the main reminder must be written first (offsets anchor to it)
      const before = lib.resolveTask(opts._[0])
      if (Object.keys(patch).length) lib.patchTodo(opts._[0], patch)
      const tid2 = lib.resolveTask(opts._[0]).taskId
      const updated = lib.open().call('getById', tid2)
      // Timeline chips follow the task (same semantics as the UI's moveTaskChips, finalized in the 2026-09-03 review):
      // day change → all chips migrate with the task (times unchanged, user-arranged extra chips are not collapsed); a task with no chips and an explicit time → add one
      if (opts.date !== undefined) {
        const mm = lib.dateExplicitTime(opts.date)
        const dayStr = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
        const oldDay = before && before.dayStart ? dayStr(before.dayStart) : null
        const newDay = updated && updated.dayStart ? dayStr(updated.dayStart) : null
        try {
          if (oldDay && newDay && oldDay !== newDay) lib.open().call('planMoveTask', { taskId: tid2, fromDay: oldDay, toDay: newDay })
          if (mm && !lib.open().call('planAll', []).some(r => r.taskId === tid2)) {
            lib.planSet(tid2, mm, { date: newDay })
          }
        } catch (e) { console.error('[plan] chip follow-up failed (non-blocking):', e.message) }
      }
      if (opts['remind-offset'] != null && opts['remind-offset'] !== true) return okMsg(lib.setReminderOffsets(opts._[0], opts['remind-offset']))
      if (opts['remind-extra'] != null && opts['remind-extra'] !== true) return okMsg(lib.setReminderExtra(opts._[0], opts['remind-extra']))
      if (opts.estimate != null) return okMsg(lib.setEstimate(opts._[0], opts.estimate), ['get ' + tid2 + ' --json to read back'])
      return okMsg(updated || { taskId: tid2 }, ['get ' + tid2 + ' --json to read back'])
    }
    case 'delete': {
      if (dry) return emitNext({ dryRun: true, taskId: lib.resolveTask(opts._[0]).taskId, would: 'soft delete → recycle bin' }, ['remove --dry-run to actually run'])
      if (!opts._[0]) throw new lib.CliError('usage: delete <taskId|keyword>', 'USAGE')
      return okMsg(lib.deleteTodo(opts._[0]), ['restore ' + opts._[0] + ' to revert', 'recycle to view recycle bin'])
    }
    case 'import': {
      const file = opts._[0]
      if (!file) throw new lib.CliError('usage: import <file.csv> [--format auto|ticktick|dida365|todoist] [--dry-run] [--category <name>] [--no-lists]', 'USAGE')
      const r = importer.importFile(file, {
        format: opts.format || 'auto',
        dryRun: !!opts['dry-run'],
        category: opts.category != null && opts.category !== true ? opts.category : null,
        useLists: !opts.lists && !opts['no-lists']
      })
      if (opts.json) {
        return emitNext(r, r.imported ? ['list --all --json to read back', 're-run the same command: duplicates are detected and skipped']
          : ['nothing to import — every row was a duplicate or skipped'])
      }
      console.log(`format: ${r.format}   rows: ${r.total}`)
      if (opts['dry-run']) console.log(`= dry run: would import ${r.wouldImport}   duplicates ${r.duplicates}   skipped ${r.skipped} (nothing written)`)
      else console.log(`✓ imported ${r.imported}   duplicates ${r.duplicates}   skipped ${r.skipped}`)
      if (r.categoriesCreated.length) console.log('  categories created: ' + r.categoriesCreated.join(', '))
      if (r.imported) console.log('  repeat rules from the source app are not carried over — re-create them with `repeat on`')
      return
    }
    case 'restore': {
      if (dry) return emitNext({ dryRun: true, taskId: lib.resolveTask(opts._[0]).taskId, would: 'restore from recycle' }, ['remove --dry-run to actually run'])
      if (!opts._[0]) throw new lib.CliError('usage: restore <taskId|keyword>', 'USAGE')
      return okMsg(lib.restoreTodo(opts._[0]), ['list --all --json to read back'])
    }
    case 'open': {
      const r = lib.launchApp({ dev: !!opts.dev })
      if (opts.json) return emit({ launched: true, pid: r.pid, dev: r.dev, note: 'single-instance lock brings the existing window to front when already running' })
      console.log('✓ launched' + (r.dev ? ' (--dev)' : '') + '; if the App is already running, the existing window comes to front')
      return
    }
    case 'doctor': {
      const d = lib.doctor()
      if (opts.json) return emit(d)
      d.checks.forEach(c => console.log(`${c.ok === true ? '✓' : c.ok === false ? '✗' : '·'} ${c.check}: ${c.detail}`))
      console.log(d.ok ? '== environment OK ==' : '== issues found ==')
      return
    }
    case 'clean': {
      // Environment cleanup (same implementation as cli/env-clean.js): only touches regenerable test/dev residue, never real user data directories.
      let appRoot = path.resolve(__dirname, '..')
      let probe = __dirname
      for (let i = 0; i < 6; i++) {
        try {
          if (JSON.parse(fs.readFileSync(path.join(probe, 'package.json'), 'utf8')).name === 'pickdone') { appRoot = probe; break }
        } catch {}
        const up = path.dirname(probe)
        if (up === probe) break
        probe = up
      }
      const r = require('./env-clean.js').cleanEnv({
        all: !!opts.all,
        dry: !!(opts['dry-run'] || opts.dry),
        appRoot
      })
      if (opts.json) return emit(r)
      for (const it of r.list) {
        console.log(`${opts.dry || opts['dry-run'] ? '[dry-run] ' : it.cleaned ? 'cleaned  ' : 'skip(in use)  '}${it.label}  ${it.sizeText}  ${it.path}`)
      }
      console.log(opts.dry || opts['dry-run']
        ? `dry-run: ${r.list.length} item(s), total ${r.totalText}`
        : `done: ${r.list.filter(i => i.cleaned).length} cleaned(${r.totalText}), ${r.failedCount} skipped(in use)`)
      return
    }
    case 'restore-backup': {
      // Read-only safety command: discover + validate + guide. The DB is encrypted (better-sqlite3-multiple-ciphers
      // + db.key, see src/main/db.js), so the CLI NEVER swaps the DB file itself — the App owns real restoration.
      const SNAP = 'auto-'
      // The backup default root is externalized (userData parent dir / pickdone-backups, separate from todos.db); falls back to userData/backups for old or unmigrated installs
      const extRoot = path.join(path.dirname(lib.userDataDir()), 'pickdone-backups')
      const legacyRoot = path.join(lib.userDataDir(), 'backups')
      let backupRoot = legacyRoot
      try {
        const extHas = fs.existsSync(extRoot) && fs.readdirSync(extRoot).some(f => f.startsWith(SNAP) && f.endsWith('.json'))
        const legacyHas = fs.existsSync(legacyRoot) && fs.readdirSync(legacyRoot).some(f => f.startsWith(SNAP) && f.endsWith('.json'))
        if (extHas && !legacyHas) backupRoot = extRoot // when both sides hold snapshots, prefer the legacy dir (external root only after migration)
      } catch {}
      if (!opts._.length) {
        // List recoverable auto snapshots (no DB access, no writes)
        const files = fs.existsSync(backupRoot)
          ? fs.readdirSync(backupRoot).filter(f => f.startsWith(SNAP) && f.endsWith('.json'))
            .map(f => { const st = fs.statSync(path.join(backupRoot, f)); return { file: f, mtime: st.mtimeMs, size: st.size } })
            .sort((a, b) => b.mtime - a.mtime)
          : []
        if (opts.json) return emit({ backupDir: backupRoot, snapshots: files })
        if (!files.length) { console.log(`(no auto-*.json snapshots in ${backupRoot})`); return }
        console.log('Recoverable snapshots (newest first):')
        files.forEach(f => console.log(`  ${f.file}  modified ${dayjs(f.mtime).format('YYYY-MM-DD HH:mm:ss')}  (${f.size} bytes)`))
        console.log('Run `restore-backup <path>` to validate one and see how to restore it.')
        return
      }
      const file = path.resolve(opts._[0])
      if (!fs.existsSync(file)) throw new lib.CliError(`snapshot file not found: ${file}`, 'SNAPSHOT_NOT_FOUND')
      let snap
      try { snap = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
        throw new lib.CliError(`snapshot is not valid JSON: ${file} (${e.message})`, 'SNAPSHOT_INVALID')
      }
      // Summarize whatever the JSON exposes (schema tolerant)
      const summary = {
        file,
        todos: Array.isArray(snap.todos) ? snap.todos.length
          : Array.isArray(snap.todoList) ? snap.todoList.length
            : Array.isArray(snap) ? snap.length : null,
        categories: Array.isArray(snap.categories) ? snap.categories.length : null,
        meta: snap.meta && typeof snap.meta === 'object' ? Object.keys(snap.meta).length : null,
        savedAt: snap.savedAt || snap.createTime || snap.time || null
      }
      if (opts.json) return emit({ ...summary, guide: 'Open the App: Settings -> Backup -> Restore from snapshot, then select this file.' })
      console.log('Snapshot OK (valid JSON): ' + file)
      if (summary.todos != null) console.log(`  tasks: ${summary.todos}`)
      if (summary.categories != null) console.log(`  categories: ${summary.categories}`)
      if (summary.savedAt) console.log(`  savedAt: ${dayjs(summary.savedAt).format('YYYY-MM-DD HH:mm:ss')}`)
      console.log('')
      console.log('The CLI does not replace the database (the DB file is encrypted with db.key and must be restored by the App).')
      console.log('To restore: open the App -> Settings -> Backup -> Restore from snapshot, and select this file.')
      return
    }

    case 'purge': {
      const rows = lib.recycleTasks()
      if (opts['dry-run'] || opts.dryRun) {
        if (opts.json) return emit({ dryRun: true, count: rows.length, data: rows })
        console.log(rows.length ? rows.map(t => `  will purge: ${t.taskContent} (${t.taskId})`).join('\n') : '(recycle bin is empty, nothing to purge)')
        return
      }
      if (!opts.yes) throw new lib.CliError('purge empties the recycle bin irreversibly. Run --dry-run first to preview, then add --yes to execute (agents must have explicit user authorization)', 'NEEDS_CONFIRM')
      lib.purgeRecycleBin()
      if (opts.json) return emit({ purged: rows.length })
      console.log(`✓ recycle bin emptied (${rows.length} item(s))`)
      return
    }

    /* ---- subtasks (subtasks, same structure as EditPanel) ---- */
    case 'subtask': {
      const [op, task, ...rest] = opts._
      if (!op || !task) throw new lib.CliError('usage: subtask <add|check|uncheck|rm> <taskId|keyword> [n|subtask text]', 'USAGE')
      let t
      if (op === 'add') {
        const text = rest.join(' ')
        t = lib.addSubtask(task, text)
      } else if (op === 'check' || op === 'uncheck') {
        if (!rest[0]) throw new lib.CliError('subtask index or text required', 'USAGE')
        t = lib.checkSubtask(task, rest[0], op === 'check')
      } else if (op === 'rm') {
        if (!rest[0]) throw new lib.CliError('subtask index or text required', 'USAGE')
        t = lib.removeSubtask(task, rest[0])
      } else if (op === 'move') {
        // move <task> <n> up|down|top|bottom|to <m> — same subtasks order as EditPanel drag
        const [n, where, target] = rest
        if (!n || !where) throw new lib.CliError('usage: subtask move <task> <n> up|down|top|bottom|to <m>', 'USAGE')
        const r = lib.moveSubtask(task, n, where, target)
        if (opts.json) return emit(r)
        console.log('✓ moved. order now:')
        r.order.forEach(x => console.log('    ' + x))
        return
      } else throw new lib.CliError(`unknown sub-operation "${op}" (valid: add/check/uncheck/rm/move)`)
      const subs = lib.parseSubs(t)
      if (opts.json) return emit({ data: t, subtasks: subs })
      console.log('✓ ' + fmtTodoLine(t))
      subs.forEach((x, i) => console.log(`    ${i + 1}. ${x.checked ? '[x]' : '[ ]'} ${x.text}`))
      return
    }




    /* ---- attachments: copies the file into userData/files and appends to the task's img/file list (same storage as UI uploads) ---- */
    case 'attachment': {
      const [op, task, ...files] = opts._
      if (op === 'add') {
        if (!task || !files.length) throw new lib.CliError('usage: attachment add <taskId|keyword> <file...>  (50MB max, extension whitelist)', 'USAGE')
        const results = files.map(f => lib.addAttachment(task, f))
        return okMsg(results.length === 1 ? results[0] : { attached: results.length, files: results.map(r => r.name) })
      }
      if (op === 'list') {
        if (!task) throw new lib.CliError('usage: attachment list <taskId|keyword>', 'USAGE')
        const r = lib.listAttachments(task)
        if (opts.json) return emit(r)
        const show = (label, arr) => arr.forEach((a, i) => console.log(`  ${label}${i + 1}. ${a.name}  (${Math.round((a.size || 0) / 1024)}KB)`))
        show('img', r.images); show('file', r.files)
        if (!r.images.length && !r.files.length) console.log('(no attachments)')
        return
      }
      if (op === 'rm' || op === 'remove') {
        const [kind, n] = files
        if (!kind || !n) throw new lib.CliError('usage: attachment rm <taskId|keyword> img|file <n>  (n from attachment list)', 'USAGE')
        return okMsg(lib.removeAttachment(task, kind, n))
      }
      throw new lib.CliError('unknown sub-operation "' + op + '" (valid: add/list/rm)', 'UNKNOWN_ARG')
    }

    /* ---- settings: read current values, set a key (hot-synced to the running App via the db watcher) ---- */
    case 'settings': {
      const [op, key, ...srest] = opts._
      if (!op || op === 'list') {
        const rows = lib.settingsList()
        if (opts.json) return emit(rows)
        for (const r of rows) console.log(`${r.key}  =  ${JSON.stringify(r.value)}   [${r.type}${r.options ? ': ' + r.options.join('|') : ''}]`)
        console.log('-- settings set <key> <value> to change; a running App picks it up within ~2s')
        return
      }
      if (op === 'get') {
        if (!key) throw new lib.CliError('usage: settings get <key>', 'USAGE')
        const row = lib.settingsList().find(r => r.key === key)
        if (!row) throw new lib.CliError('unknown setting "' + key + '"', 'UNKNOWN_KEY')
        return opts.json ? emit(row) : console.log(`${row.key} = ${JSON.stringify(row.value)}`)
      }
      if (op === 'set') {
        const value = srest.join(' ')
        if (!key || !value) throw new lib.CliError('usage: settings set <key> <value>   e.g. settings set backupDir "D:\\backups" / settings set colorMode dark', 'USAGE')
        return okMsg(lib.settingsSet(key, value), ['settings list --json to verify', 'a running App applies it within ~2s'])
      }
      throw new lib.CliError('unknown sub-operation "' + op + '" (valid: list/get/set)', 'UNKNOWN_ARG')
    }

    /* ---- day-timeline plan chips: SQLite plan_chips rows, same store the App's DayRail timeline reads/writes ---- */
    case 'plan': {
      const [op, a, b] = opts._
      if (op === 'list' || !op) {
        const r = lib.planList(a != null && a !== 'list' ? a : opts.date)
        if (opts.json) return emit(r)
        if (!r.tasks.length) return console.log('(no chips on ' + r.day + ')')
        for (const t of r.tasks) console.log(`${t.chips.join(' + ')}  [${t.complete ? 'x' : ' '}] ${t.content}`)
        return
      }
      if (op === 'set') {
        if (!a || !b) throw new lib.CliError('usage: plan set <taskId|keyword> <HH:mm> [--date D] [--replace]', 'USAGE')
        return okMsg(lib.planSet(a, b, { date: opts.date, replace: !!opts.replace }), ['plan list --json to see the day timeline'])
      }
      if (op === 'rm' || op === 'remove') {
        if (!a) throw new lib.CliError('usage: plan rm <taskId|keyword> [--at HH:mm] [--date D]', 'USAGE')
        return okMsg(lib.planRemove(a, { date: opts.date, at: opts.at !== true ? opts.at : undefined }))
      }
      // Shortcut form: plan <task> <HH:mm> schedules directly
      if (a && !['set', 'list', 'rm', 'remove'].includes(op)) {
        return okMsg(lib.planSet(op, a, { date: opts.date, replace: !!opts.replace }), ['plan list --json to see the day timeline'])
      }
      throw new lib.CliError('unknown sub-operation "' + op + '" (valid: set/list/rm, or plan <task> <HH:mm>)', 'UNKNOWN_ARG')
    }

    /* ---- repeat rules ---- */
    case 'repeat': {
      const [op, task] = opts._
      if (op === 'on') {
        if (!task) throw new lib.CliError('usage: repeat on <task> [--type daily|weekly|monthly|yearly] [--interval N] [--weekdays 1,3,5] [--count N]', 'USAGE')
        const rule = lib.buildRepeatRule(opts)
        const r = lib.repeatOn(task, rule, parseInt(opts.count, 10) || 0)
        if (opts.json) return emitNext({ rid: r.rid, rule, made: r.made }, ['list --json to see generated instances', 'repeat rule ' + task + ' to inspect'])
        console.log('✓ repeat set: group ' + r.rid + ', generated ' + r.made + ' future instance(s)')
        return
      }
      if (op === 'off') {
        const r = lib.repeatOff(task, opts.all)
        if (opts.json) return emitNext(r, ['list --json to read back'])
        console.log('✓ left repeat group' + (opts.all ? ' (soft-deleted ' + r.removed + ' future instance(s))' : ''))
        return
      }
      if (op === 'rule') {
        const info = lib.repeatRuleInfo(task)
        if (opts.json) return emit(info)
        console.log(JSON.stringify(info, null, 2))
        return
      }
      throw new lib.CliError('usage: repeat <on|off|rule>', 'USAGE')
    }

    /* ---- tomato command channel: write meta command → running App dispatches existing tomato action → writes back cliTomatoState ---- */
    case 'tomato': {
      const [op, ...rest] = opts._
      /* ---- tomato list: read-only query of the focus ledger (SQLite tomato_records row table; same source as the statistics page, works without the App) ---- */
      if (op === 'list') {
        let recs = lib.tomatoRecords().sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
        const date = opts.date ? String(opts.date) : null
        if (date && date !== 'today' && date !== 'yesterday') {
          const d = lib.parseDate(date)
          recs = recs.filter(r => r.dateKey === dayjs(d).format('YYYY-MM-DD'))
        } else if (date === 'today') recs = recs.filter(r => r.dateKey === dayjs().format('YYYY-MM-DD'))
        else if (date === 'yesterday') recs = recs.filter(r => r.dateKey === dayjs().subtract(1, 'day').format('YYYY-MM-DD'))
        const taskRef = opts.task != null && opts.task !== true ? opts.task : rest[0]
        if (taskRef) {
          const t = lib.resolveTask(taskRef, lib.liveTasks())
          recs = recs.filter(r => r.focusTaskId === t.taskId || (r.focus || '').includes(t.taskContent))
        }
        const limit = Math.max(1, Math.min(200, parseInt(opts.n || opts.limit, 10) || 30))
        recs = recs.slice(0, limit)
        // The focus text may be a stale task name after re-attachment (same semantics as the UI: consumers resolve by focusTaskId) — resolve the task name live at display time
        const live = lib.liveTasks()
        const nameOf = r => {
          if (r.focusTaskId) { const t = live.find(x => x.taskId === r.focusTaskId); if (t) return t.taskContent }
          return r.focus || ''
        }
        if (opts.json) {
          return emit(recs.map(r => ({ ...r, focus: nameOf(r) })))
        }
        if (!recs.length) return console.log('(no focus records match)')
        for (const r of recs) {
          const start = r.endTime ? dayjs(r.endTime - (r.focusDuration || 0) * 60000).format('MM-DD HH:mm') : '—'
          const end = r.endTime ? dayjs(r.endTime).format('HH:mm') : ''
          console.log(`${r.dateKey}  ${start}~${end}  ${r.focusDuration || 0}min${r.restDuration ? '+' + r.restDuration + 'min rest' : ''}  ${r.succeed === false ? '✗abandoned' : '✓'}${r.manual ? ' (backfilled)' : ''}  ${nameOf(r) || '(free focus)'}`)
        }
        console.log(`-- ${recs.length} record(s)`)
        return
      }
      if (op === 'record') {
        // ---- Fix/delete ledgered focus records (correcting wrong durations / mistaken backfills; direct ledger row writes, works without the App) ----
        const [rop, ref] = rest
        if (rop === 'rm' || rop === 'remove' || rop === 'delete') {
          if (!ref) throw new lib.CliError('usage: tomato record rm <tomatoId|prefix>  (tomato list to browse ids)', 'USAGE')
          const { rec } = lib.recordRemove(ref) // 账本行直删,无需 App 运行
          if (opts.json) return emit({ removed: rec.tomatoId, dateKey: rec.dateKey, minutes: rec.focusDuration })
          return console.log(`✓ record removed: ${rec.dateKey} ${rec.focusDuration}min ${rec.focus || '(free focus)'}`)
        }
        if (rop === 'fix') {
          if (!ref) throw new lib.CliError('usage: tomato record fix <tomatoId|prefix> [--minutes N] [--date D --at HH:mm] [--rest N] [--succeed yes|no] [--task <kw|--free>]', 'USAGE')
          const { rec } = lib.recordFix(ref, {
            minutes: opts.minutes, date: opts.date, at: opts.at, rest: opts.rest,
            succeed: opts.succeed,
            task: opts.task != null && opts.task !== true ? opts.task : undefined,
            free: opts.free === true
          })
          const after = lib.resolveRecord(rec.tomatoId)
          const live = lib.liveTasks()
          const nt = after.focusTaskId ? live.find(x => x.taskId === after.focusTaskId) : null
          const shown = nt ? nt.taskContent : (after.focus || '(free focus)')
          if (opts.json) return emit({ fixed: after.tomatoId, dateKey: after.dateKey, focusDuration: after.focusDuration, restDuration: after.restDuration, succeed: after.succeed, focus: shown })
          return console.log(`✓ record fixed: ${after.dateKey} ${after.focusDuration}min${after.restDuration ? '+' + after.restDuration + 'min rest' : ''} ${after.succeed === false ? '✗abandoned' : '✓'} ${shown}`)
        }
        throw new lib.CliError('unknown sub-operation "' + rop + '" (valid: fix/rm)', 'UNKNOWN_ARG')
      }
      if (op === 'status') {
        const st = lib.readTomatoState()
        if (!st) {
          const unknown = { status: 'unknown', remainSec: null, tomatoTime: null, attach: null, todayTomatoCount: null, note: 'App has not written state yet (not running or too old)' }
          if (opts.json) return emit(unknown)
          return console.log(unknown.note)
        }
        const running0 = st.status === 'startTomatoTime' || st.status === 'startRestTime'
        // In idle the App no longer writes back, so state inevitably ages — only judge stale while running
        const stale = running0 && (!st.at || Date.now() - st.at > 5000)
        const remain = lib.tomatoLiveRemainSec(st)
        const tag = { startTomatoTime: 'focusing', startRestTime: 'resting', default: 'idle' }[st.status] || st.status
        if (opts.json) return emit({ ...st, remainSec: remain, stale, status: tag })
        console.log(`${tag}${stale ? ' (stale)' : ''}` +
          (running0 ? `  ${Math.max(0, Math.round(remain / 60))} min left` : '') +
          `  ${st.todayTomatoCount} today` + (st.attach ? `  attached: ${st.attach.content}` : ''))
        return
      }
      if (op === 'start') {
        let taskId = null
        const taskRef = opts.task
        if (taskRef) {
          const t = lib.resolveTask(taskRef, lib.liveTasks()) // live pool only (recycle bin cannot attach)
          taskId = t.taskId
        }
        const minutes = parseInt(opts.minutes, 10)
        const seq = lib.writeTomatoCmd({ action: 'start', taskId, minutes: minutes > 0 ? minutes : null })
        // HELP contract: error out when the App is not running instead of faking success. Wait for the receipt to catch up; timeout = command not consumed
        const ack = await lib.waitForTomatoAck(seq)
        if (!ack) throw new lib.CliError('tomato start failed: App is not running or did not consume the command (launch with: open)', 'APP_NOT_RUNNING')
        if (opts.json) return emitNext({ seq, taskId, minutes: minutes > 0 ? minutes : null, acknowledged: true }, ['tomato status --json for countdown', 'tomato stop to stop'])
        console.log('✓ focus started' + (taskId ? ' (attached task ' + taskId + ')' : '') + (minutes > 0 ? ' for ' + minutes + ' min' : ''))
        return
      }
      if (op === 'stop') {
        const seq = lib.writeTomatoCmd({ action: 'stop', reason: opts.reason || '', record: !opts['no-record'] })
        const ack = await lib.waitForTomatoAck(seq)
        if (!ack) throw new lib.CliError('tomato stop failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (opts.json) return emitNext({ seq, record: !opts['no-record'], acknowledged: true }, ['tomato status --json to confirm idle', 'stats --json to see focus records'])
        console.log('✓ stopped' + (opts['no-record'] ? ' (no record)' : ' (records by focused minutes)'))
        return
      }
      if (op === 'attach') {
        const ref = rest[0]
        let taskId = null
        if (ref && ref !== '--none' && ref !== 'none') {
          taskId = lib.resolveTask(ref, lib.liveTasks()).taskId
        }
        const seq = lib.writeTomatoCmd({ action: 'attach', taskId })
        // 与 start/stop 同契约等回执:App 未运行时不再谎报成功(2026-09-04 深审 P0,同命令族三种契约曾让 JSON 消费者无统一判断路径)
        const ack = await lib.waitForTomatoAck(seq)
        if (!ack) throw new lib.CliError('tomato attach failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (opts.json) return emit({ seq, taskId, acknowledged: true })
        console.log(taskId ? '✓ tomato task attached ' + taskId : '✓ tomato task detached')
        return
      }
      if (op === 'backfill') {
        /* Backfill: user says "I did X during this slot, log it for me" — record a focus block into the ledger at a given date/time
           (manual:true is a real record, increments the actual pomodoro count, reconcilable on the 24h timeline; same semantics as the UI's right-click one-click backfill).
           CLI 直写 tomato_records 行表,App 关闭也可用;App 运行中经 tomato-records-changed 广播即时回灌。 */
        const ref = opts.task || rest[0] || (opts.free ? '--free' : undefined)
        if (!ref) throw new lib.CliError('usage: tomato backfill <taskId|keyword|--free> [--date today|YYYY-MM-DD] [--minutes 25] [--at HH:mm]  (--free = free focus, not attached to a task)', 'USAGE')
        let taskId = null
        let content = ''
        if (ref !== '--free' && ref !== 'free') {
          const t = lib.resolveTask(ref, lib.liveTasks())
          taskId = t.taskId
          content = t.taskContent
        }
        // Local-timezone YYYY-MM-DD (do not use toISOString: UTC shifts the whole block by a day for evening use)
        const localYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const dateStr = (raw => {
          if (raw === undefined || raw === true || raw === 'today' || raw === '') return localYmd(new Date())
          if (raw === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); return localYmd(d) }
          if (raw === 'yesterday') { const d = new Date(); d.setDate(d.getDate() - 1); return localYmd(d) }
          const rel = /^\+(\d+)d$/.exec(raw)
          if (rel) { const d = new Date(); d.setDate(d.getDate() + parseInt(rel[1], 10)); return localYmd(d) }
          return raw
        })(opts.date)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          throw new lib.CliError('bad --date "' + opts.date + '" (use today/tomorrow/+Nd/YYYY-MM-DD)', 'USAGE')
        }
        const at = (opts.at && opts.at !== true) ? String(opts.at) : '20:00'
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new lib.CliError('bad --at "' + opts.at + '" (use HH:mm, 24h)', 'USAGE')
        const minutes = parseInt(opts.minutes, 10) > 0 ? parseInt(opts.minutes, 10) : 25
        const rec = lib.backfillRecord({ taskId, content, date: dateStr, at, minutes })
        if (opts.json) return emitNext({ tomatoId: rec.tomatoId, dateKey: rec.dateKey, minutes: rec.focusDuration, acknowledged: true }, ['stats --json to see focus minutes', 'list --json to read back'])
        console.log(`✓ backfilled ${rec.focusDuration} min on ${rec.dateKey} ${at}` + (taskId ? ' → ' + (content || taskId) : ' (free focus, no task)'))
        return
      }
      throw new lib.CliError('usage: tomato <status|start|stop|attach|backfill> (start accepts --task/--minutes; backfill accepts --task/--free/--date/--minutes/--at)', 'USAGE')
    }

    case 'events': {
      if (opts._[0] !== 'import') throw new lib.CliError('usage: events import --file <events.json>', 'USAGE')
      const file = typeof opts.file === 'string' ? opts.file : null
      if (!file || !require('fs').existsSync(file)) throw new lib.CliError('bad --file "' + opts.file + '" (JSON array of events)', 'USAGE')
      const events = JSON.parse(require('fs').readFileSync(file, 'utf8'))
      if (dry) return emitNext({ dryRun: true, total: events.length, sample: events.slice(0, 3) }, ['events import --file <events.json> to actually run'])
      const result = await lib.importEvents(events, { onProgress: p => {
        if (!opts.json) process.stdout.write((p.status === 'failed' ? '✗ ' : p.status === 'created' ? '✓ ' : '· ') + p.label + '\n')
      } })
      // 契约:部分失败 = 退出码 2 + 顶层 ok 字段(2026-09-04 深审 P0:恒 0 曾让脚本管道把部分失败当成功)
      // 退出码必须在 opts.json return 之前设置——放 return 后 JSON 路径(恰是脚本消费者)恒 0(二轮深审 P0)
      if (result.failed.length) process.exitCode = 2
      const ok = result.failed.length === 0
      if (opts.json) return emitNext({ ok, created: result.created, skipped: result.skipped, failed: result.failed, total: result.total }, ['stats --from <d> --to <d> to verify', 'log --n 40 to audit'])
      console.log('DONE created=' + result.created + ' skipped=' + result.skipped + ' failed=' + result.failed.length + '/' + result.total)
      if (result.failed.length) console.log(result.failed.map(f => '✗ ' + f.label + ': ' + f.error).join('\n'))
      return
    }


    case 'update': {
      // Compare local version against the latest GitHub release (no download here;
      // installing stays in the App's built-in updater). Degrades gracefully while the repo is private.
      let latest = null
      let note = ''
      try {
        const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'pickdone-cli' }, signal: AbortSignal.timeout(8000) })
        if (res.status === 404) note = 'no published release yet (repo is private or has no releases)'
        else if (!res.ok) note = `GitHub API returned ${res.status}`
        else {
          const body = await res.json()
          latest = { tag: body.tag_name, name: body.name || body.tag_name, url: body.html_url, publishedAt: body.published_at }
        }
      } catch (e) {
        note = `cannot reach GitHub (${e.name === 'TimeoutError' ? 'timeout' : e.message})`
      }
      // Numeric segment compare: lexicographic would call 0.10.0 older than 0.2.0
      const cmp = v => String(v).replace(/^v/, '').split('.').map(Number)
      const newer = (a, b) => { const x = cmp(a), y = cmp(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false }
      const upToDate = !latest || !newer(latest.tag, CLI_VERSION)
      const data = { local: CLI_VERSION, latest: latest ? latest.tag : null, upToDate, url: latest ? latest.url : null, note: note || undefined }
      if (opts.json) return emit(data)
      console.log(`local:  v${CLI_VERSION}`)
      if (!latest) console.log(`latest: unavailable — ${note}`)
      else if (upToDate) console.log(`latest: ${latest.tag} — you are up to date`)
      else {
        console.log(`latest: ${latest.tag} — a newer release is available`)
        console.log(`install: open the App → Settings → check for updates (${latest.url})`)
      }
      return
    }

    case 'skill': {
      // Install the bundled SKILL.md so local AI agents (ZCode / Claude Code) discover the CLI.
      if (argv[1] !== 'install') throw new lib.CliError('usage: skill install', 'USAGE')
      const src = path.join(__dirname, 'SKILL.md')
      if (!fs.existsSync(src)) throw new lib.CliError('SKILL.md not found next to pickdone.js', 'NOT_FOUND')
      const content = fs.readFileSync(src, 'utf8')
      const home = process.env.USERPROFILE || process.env.HOME
      const targets = [
        path.join(home, '.zcode', 'skills', 'pickdone', 'SKILL.md'),
        path.join(home, '.claude', 'skills', 'pickdone', 'SKILL.md'),
        path.join(home, '.cursor', 'skills', 'pickdone', 'SKILL.md')
      ]
      const results = targets.map(dest => {
        const exists = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === content
        if (!exists) {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, content)
        }
        return { dest, installed: !exists }
      })
      // Legacy install name from earlier builds — clean up so agents don't see a stale duplicate skill
      for (const root of ['.zcode', '.claude']) {
        // Install already succeeded at this point — a locked/EPERM legacy dir must not fail the whole command
        try { fs.rmSync(path.join(home, root, 'skills', 'todo-cli'), { recursive: true, force: true }) } catch { /* note below */ }
      }
      const data = { source: src, results }
      if (opts.json) return emit(data)
      for (const r of results) console.log(`${r.installed ? '✓ installed' : '• up to date'}  ${r.dest}`)
      return
    }

    default:
      throw new lib.CliError(`unknown command "${cmd}"\n\n${HELP}`, 'UNKNOWN_COMMAND')
  }
}

main().catch(e => fail(e, process.argv[2]))
