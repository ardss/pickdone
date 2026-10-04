#!/usr/bin/env node
/**
 * Schedule/task-shape command groups (subtask/attachment/settings/plan/repeat) for
 * cli/pickdone.js — extracted unchanged from the switch cases (size ratchet: pure move).
 */
const { fmtTodoLine } = require('./cli-format.cjs')

/* ---- subtasks (subtasks, same structure as EditPanel) ---- */
function runSubtask ({ opts, lib, emit }) {
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
function runAttachment ({ opts, lib, emit, okMsg }) {
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
    const r = lib.removeAttachment(task, kind, n)
    return okMsg(r, null, `removed ${r.removed} attachment(s) from ${r.taskId}`)
  }
  throw new lib.CliError('unknown sub-operation "' + op + '" (valid: add/list/rm)', 'UNKNOWN_ARG')
}

/* ---- settings: read current values, set a key (hot-synced to the running App via the db watcher) ---- */
function runSettings ({ opts, lib, emit, okMsg }) {
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
    const s = lib.settingsSet(key, value, { force: !!opts.force })
    return okMsg(s, ['settings list --json to verify', 'a running App applies it within ~2s'],
      `setting ${s.key} = ${JSON.stringify(s.value)} (was ${JSON.stringify(s.previous)})`)
  }
  throw new lib.CliError('unknown sub-operation "' + op + '" (valid: list/get/set)', 'UNKNOWN_ARG')
}

/* ---- day-timeline plan chips: SQLite plan_chips rows, same store the App's DayRail timeline reads/writes ---- */
function runPlan ({ opts, lib, emit, okMsg }) {
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
    const p = lib.planSet(a, b, { date: opts.date, replace: !!opts.replace })
    return okMsg(p, ['plan list --json to see the day timeline'], `plan [${p.day}] ${p.content}: ${p.chips.join(' + ')}`)
  }
  if (op === 'rm' || op === 'remove') {
    if (!a) throw new lib.CliError('usage: plan rm <taskId|keyword> [--at HH:mm] [--date D]', 'USAGE')
    const p = lib.planRemove(a, { date: opts.date, at: opts.at !== true ? opts.at : undefined })
    return okMsg(p, null, `plan [${p.day}] ${p.taskId}: removed ${p.removed} chip(s)`)
  }
  // Shortcut form: plan <task> <HH:mm> schedules directly
  if (a && !['set', 'list', 'rm', 'remove'].includes(op)) {
    const p = lib.planSet(op, a, { date: opts.date, replace: !!opts.replace })
    return okMsg(p, ['plan list --json to see the day timeline'], `plan [${p.day}] ${p.content}: ${p.chips.join(' + ')}`)
  }
  throw new lib.CliError('unknown sub-operation "' + op + '" (valid: set/list/rm, or plan <task> <HH:mm>)', 'UNKNOWN_ARG')
}

/* ---- repeat rules ---- */
function runRepeat ({ opts, lib, emit, emitNext }) {
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
    // D18-DOM2 #2/#3: both scopes now DELETE (App RepeatDeleteModal parity) — the single scope
    // soft-deletes the instance ([A2 fix]: "the user pressed Delete and nothing disappeared"),
    // --all dissolves the whole group (completed instances included)
    console.log('✓ repeat off' + (opts.all ? ': group dissolved (soft-deleted ' + r.removed + ' instance(s), completed included)' : ': instance soft-deleted (this event only)'))
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

module.exports = { runSubtask, runAttachment, runSettings, runPlan, runRepeat }
