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
    const oldTag = String(oldName).replace(/^#/, '').trim()
    const nextTag = String(next).replace(/^#/, '').trim()
    if (!oldTag) throw new lib.CliError('usage: tag rename <old> <new>', 'USAGE')
    // D25 W2: an empty/whitespace new name used to leak a bare "# " fragment into task text; strip cleanly instead
    if (!nextTag) return lib.rewriteTag(oldTag, null, { remove: true })
    const touched = lib.rewriteTag(oldTag, nextTag)
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
  const api = require('./lib-project-v2.cjs')({ lib })
  let ps = api.list()
  if (opts.status != null && opts.status !== true) {
    if (!lib.PROJECT_STATUS_VALUES.includes(opts.status)) throw new lib.CliError('--status accepts ' + lib.PROJECT_STATUS_VALUES.join('|'), 'USAGE')
    ps = ps.filter(p => p.status === opts.status)
  }
  if (opts.json) return emit(ps)
  if (!ps.length) return console.log('(no projects — use project-v2 add <name> or project <category> --on)')
  console.log('Name\tProgress\tTasks\tFocus (min)\tOverdue\tNext 7 days\tStatus\tStarted')
  ps.forEach(p => console.log(p.name+'\t'+p.progress+'%\t'+p.done+'/'+p.total+'\t'+p.focusMinutes+'\t'+p.overdue+'\t'+p.next7days+'\t'+p.status+'\t'+(p.startedAt ? dayjs(p.startedAt).format('YYYY-MM-DD') : '—')))
}

function runProject ({ opts, lib, emit }) {
  const input = opts._[0]
  if (!input) throw new lib.CliError('usage: project <name|projectId|legacyCategoryId> [--on|--off] [--status active|paused|done|cancelled] [--deadline YYYY-MM-DD|none]', 'USAGE')
  const api = require('./lib-project-v2.cjs')({ lib })
  const resolve = () => api.list().find(p => p.projectId === input || String(p.legacyCategoryId || '') === String(input) || p.name === input)
  if (opts.on && opts.off) throw new lib.CliError('--on and --off cannot be combined', 'USAGE')
  if (opts.on) {
    const id = lib.resolveCategory(input)
    const converted = api.fromCategory({ categoryId: id })
    if (opts.json) return emit(converted)
    return console.log('Project "' + converted.name + '" now uses independent identity ' + converted.projectId)
  }
  const project = resolve()
  if (!project) throw new lib.CliError('project not found: ' + input, 'PROJECT_V2_NOT_FOUND')
  if (opts.off) {
    const result = api.update({ projectId: project.projectId, patch: { deleted: true } })
    if (opts.json) return emit(result)
    return console.log('Project archived: ' + project.name)
  }
  if (opts.status !== undefined || opts.deadline !== undefined) {
    // Validate the entire patch before writing. V2 entity is authoritative.
    const patch = {}
    if (opts.status !== undefined) {
      const status = opts.status === 'none' ? 'active' : opts.status
      if (opts.status === true || !lib.PROJECT_STATUS_VALUES.includes(status)) {
        throw new lib.CliError('--status accepts '+lib.PROJECT_STATUS_VALUES.join('|')+'|none', 'USAGE')
      }
      patch.status = status
    }
    if (opts.deadline !== undefined) {
      const dateInput = opts.deadline
      if (['none', 'clear', ''].includes(String(dateInput).toLowerCase())) {
        patch.deadline = 0
      } else {
        try { patch.deadline = lib.dayStartOf(lib.parseDate(dateInput)) } catch (e) {
          throw new lib.CliError('cannot parse date: '+dateInput, 'BAD_DATE')
        }
        if (!Number.isSafeInteger(patch.deadline) || patch.deadline <= 0) {
          throw new lib.CliError('cannot parse date: '+dateInput, 'BAD_DATE')
        }
      }
    }
    const result = api.update({ projectId: project.projectId, patch })
    if (opts.json) return emit({ ...result, deadline: result.deadline == null ? project.deadline : result.deadline })
    return console.log('Project updated: ' + result.name)
  }
  const tasks = api.projectTasks(project.projectId)
  if (opts.json) return emit({ ...project, tasks })
  const d = project.deadline ? ' deadline ' + dayjs(project.deadline).format('YYYY-MM-DD') : ''
  console.log(project.name+'  '+project.progress+'%  ('+project.done+'/'+project.total+')   status '+project.status+d)
  console.log('Started '+(project.startedAt ? dayjs(project.startedAt).format('YYYY-MM-DD') : '—')+'   Focus '+project.focusMinutes+' min   Overdue '+project.overdue+'   Next 7 days '+project.next7days)
  console.log(tasks.length ? '\n' + tasks.map(t => fmtTodoLine(t)).join('\n') : '\n(no tasks)')
}

function runMilestone ({ opts, lib, emit }) {
  const [name, op, ...rest] = opts._
  if (!name) throw new lib.CliError('usage: milestone <project> [list | add <title> <date> | rm <n>]', 'USAGE')
  if (!op || op === 'list') {
    const { milestones } = lib.getMilestones(name)
    // maint/d23 P3 (D19 parity): the view/project listings were raised to 5000 for App parity but
    // the milestone task fetch was missed — milestone progress silently ignored tasks past row 500.
    const tasks = lib.milestoneTasks(name).filter(t => !t.delete)
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
