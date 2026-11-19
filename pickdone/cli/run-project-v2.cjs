'use strict'

/** PickDone CLI project-v2 command dispatch, separate from the central command router. */
module.exports = function runProjectV2 ({ opts, lib, emit }) {
  const api = require('./lib-project-v2.cjs')({ lib })
  const sub = opts._[0] || 'list'
  if (sub === 'list') return emit(api.list())
  if (sub === 'audit') return emit(api.audit())
  if (sub === 'migrate') return emit(api.migrate({ yes: !!opts.yes && !opts['dry-run'] }))
  if (sub === 'add') return emit(api.create({ name: opts._.slice(1).join(' '), color: opts.color }))
  if (sub === 'rename') return emit(api.update({ projectId: opts._[1], patch: { name: opts._.slice(2).join(' ') } }))
  if (sub === 'status') return emit(api.update({ projectId: opts._[1], patch: { status: opts._[2] } }))
  if (sub === 'archive' || sub === 'restore') return emit(api.update({ projectId: opts._[1], patch: { deleted: sub === 'archive' } }))
  if (sub === 'assign') return emit(api.assign({ taskId: opts._[1], projectId: opts._[2] }))
  if (sub === 'unassign') return emit(api.assign({ taskId: opts._[1], projectId: null }))
  if (sub === 'recover') return emit(api.recover({ legacyCategoryId: opts._[1], name: opts._.slice(2).join(' ') }))
  throw new lib.CliError('usage: project-v2 [list|audit|migrate|add|rename|status|archive|restore|assign|unassign|recover]', 'USAGE')
}
