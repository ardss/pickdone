#!/usr/bin/env node
/**
 * Taxonomy/project/milestone/view command groups for cli/pickdone.js —
 * extracted unchanged from the switch cases (size ratchet: pure move).
 */
const dayjs = require('dayjs')
const { fmtTodoLine } = require('./cli-format.cjs')

/* ---- category CRUD: same SQLite categories table as the UI (upsertCategory), writes show up after ~2s db watch ---- */
function runCategory ({ opts, lib, emit }) {
  const [op, ...rest] = opts._
  if (op === 'add') {
    const name = rest[0]
    if (!name) throw new lib.CliError('usage: category add <name> [--color #0f9d8f] [--parent <folder>] [--folder]', 'USAGE')
    const c = lib.addCategory(name, { color: opts.color !== true ? opts.color : undefined, parent: opts.parent !== true ? opts.parent : undefined, folder: !!opts.folder })
    if (opts.json) return emit({ categoryId: c.categoryId, name: c.categoryName, color: c.categoryColor, parent: c.folderId, folderIs: c.folderIs }, ['add <task> --category "' + c.categoryName + '" to file tasks into it'])
    return console.log(`✓ ${c.folderIs ? 'folder' : 'category'} created: ${c.categoryName}  (id ${c.categoryId}, color ${c.categoryColor})`)
  }
  if (op === 'move') {
    const target = rest[0]
    if (!target || opts.parent == null || opts.parent === true) throw new lib.CliError('usage: category move <name|id> --parent <folder name|id|root>', 'USAGE')
    const r = lib.moveCategory(target, opts.parent)
    if (opts.json) return emit(r)
    return console.log(`✓ "${r.name}" moved to ${r.parentName ? 'folder "' + r.parentName + '"' : 'root'}`)
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
    // P1-3 (R5): report the saved-filter cascade so CLI output matches the renderer's undo message
    return console.log('✓ deleted: ' + r.deleted.map(v => v.name).join(', ') + (r.removedFilters ? `; ${r.removedFilters} saved filter(s) removed` : ''))
  }
  throw new lib.CliError('unknown sub-operation "' + op + '" (valid: add/rename/move/rm; plain `categories` lists)', 'UNKNOWN_ARG')
}

/* ---- tags: derived from #tag in content/description; rename/rm rewrite text across all tasks ---- */
function runTag ({ opts, lib, emit }) {
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

function runProjects ({ opts, lib, emit }) {
  let ps = lib.getProjects()
  if (opts.status != null && opts.status !== true) {
    if (!lib.PROJECT_STATUS_VALUES.includes(opts.status)) throw new lib.CliError('--status accepts ' + lib.PROJECT_STATUS_VALUES.join('|'), 'USAGE')
    ps = ps.filter(p => p.status === opts.status)
  }
  if (opts.json) return emit(ps)
  if (!ps.length) return console.log('(no projects — use "set as project" in category manager, or project <category> --on)')
  console.log('Name\tProgress\tTasks\tFocus (min)\tOverdue\tNext 7 days\tStatus\tStarted')
  ps.forEach(p => console.log(`${p.name}\t${p.progress}%\t${p.done}/${p.total}\t${p.focusMinutes}\t${p.overdue}\t${p.next7days}\t${p.status}\t${p.startedAt ? dayjs(p.startedAt).format('YYYY-MM-DD') : '—'}`))
  return
}

function runProject ({ opts, lib, emit }) {
  const name = opts._[0]
  if (!name) throw new lib.CliError('usage: project <name|id> [--on|--off] [--deadline YYYY-MM-DD|none] [--status active|paused|done|cancelled|none]; no flag shows details', 'USAGE')
  if (opts.on || opts.off) {
    const r = lib.setProjectFlag(name, !!opts.on)
    if (opts.json) return emit(r)
    return console.log(`✓ "${r.name}" ${r.isProject ? 'is now a project' : 'restored to plain category'}`)
  }
  // review P2 (2026-09-10): --status and --deadline used to early-return per flag, silently dropping
  // the second flag on combined invocations; both now apply in one call
  if (opts.status !== undefined || opts.deadline !== undefined) {
    if (opts.status === true) throw new lib.CliError('--status needs a value: ' + lib.PROJECT_STATUS_VALUES.join('|') + '|none', 'USAGE')
    let r = {}
    const parts = []
    if (opts.status !== undefined) {
      r = lib.setProjectStatus(name, String(opts.status))
      parts.push(r.cleared ? 'status cleared (falls back to active)' : `status → ${r.status}`)
    }
    if (opts.deadline !== undefined) {
      const rd = lib.setProjectDeadline(name, opts.deadline)
      r = { ...r, deadline: rd.deadline, name: rd.name }
      parts.push(rd.deadline ? `deadline → ${dayjs(rd.deadline).format('YYYY-MM-DD')}` : 'deadline cleared')
    }
    if (opts.json) return emit(r)
    return console.log(`✓ "${r.name}" ` + parts.join(', '))
  }
  const id = lib.resolveCategory(name)
  const c = lib.getCategories().find(x => x.categoryId === id)
  const p = lib.projectStatus(c)
  if (opts.json) return emit(p)
  const dl = p.deadline ? `   deadline ${dayjs(p.deadline).format('YYYY-MM-DD')} (${Math.ceil((p.deadline - Date.now()) / 864e5)} days left)` : ''
  console.log(`${p.name}  ${p.progress}%  (${p.done}/${p.total})   status ${p.status}${dl}`)
  console.log(`Started ${p.startedAt ? dayjs(p.startedAt).format('YYYY-MM-DD') : '—'}   Focus ${p.focusMinutes} min   Overdue ${p.overdue}   Next 7 days ${p.next7days}`)
  // D19-DOM2 (#11): a project can hold more tasks than the old 100-row cap — the App shows all of
  // them while the CLI truncated its own listing. Raised to 5000 (listTodos still clamps ≤ 5000);
  // a bound is kept (instead of unbounded) so a pathological library cannot exhaust memory in one
  // text listing.
  const list = lib.listTodos({ category: id, limit: 5000 })
  console.log(list.length ? '\n' + list.map(t => fmtTodoLine(t)).join('\n') : '\n(no tasks)')
  return
}

function runMilestone ({ opts, lib, emit }) {
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
    return console.log(`✓ milestone added: ${r.added.title} → ${dayjs(r.added.date).format('YYYY-MM-DD')}`)
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

/* ---- saved views (smart lists): the same filters table + conds shape the App's FilterModal writes / FilterView consumes ---- */
function runView ({ opts, lib, emit, emitNext }) {
  const [op, ...rest] = opts._
  if (!op || op === 'list') {
    const rows = lib.viewsList()
    if (opts.json) return emit(rows)
    if (!rows.length) return console.log('(no saved views — view add <name> [--category ..] [--priority 0-3] [--overdue] [--nodate] creates one)')
    console.log(rows.map(v => `${v.id}\t${v.name}\t${lib.viewCondsSummary(v.conds)}`).join('\n'))
    return
  }
  if (op === 'add') {
    const name = rest[0]
    if (!name) throw new lib.CliError('usage: view add <name> [--category <name|id>] [--priority 0-3] [--overdue] [--nodate]', 'USAGE')
    // Flags the shared conds contract cannot persist (db.js normConds keeps catId/priority/dateMode only):
    // reject instead of silently storing a condition the App's FilterView would never apply
    for (const bad of ['keyword', 'important', 'urgent', 'complete']) {
      if (opts[bad] != null) throw new lib.CliError(`--${bad} is not part of the saved-view conds contract (catId/priority/dateMode only); narrow inline instead: list --view <name> --${bad} ..`, 'USAGE')
    }
    const v = lib.viewAdd(name, { category: opts.category, priority: opts.priority, overdue: !!opts.overdue, nodate: !!opts.nodate })
    if (opts.json) return emitNext(v, ['list --view ' + v.id + ' --json to read it back'])
    return console.log(`✓ view created: ${v.name}  (id ${v.id}, ${lib.viewCondsSummary(v.conds)})`)
  }
  if (op === 'rm' || op === 'delete') {
    const target = rest[0]
    if (!target) throw new lib.CliError('usage: view rm <name|id>', 'USAGE')
    const r = lib.viewRm(target)
    if (opts.json) return emit(r)
    return console.log('✓ view removed: ' + r.name)
  }
  throw new lib.CliError('unknown sub-operation "' + op + '" (valid: list/add/rm)', 'UNKNOWN_ARG')
}

module.exports = { runCategory, runTag, runProjects, runProject, runMilestone, runView }
