// G10 conflict-sheet decision planner (pure, no Vue/transport/DB).
// Input: one mergePull conflict ({entity, id, verdict, local, incoming}) — `local` is the raw
// stored row, `incoming` the decoded peer row — plus the user's choice from the sheet:
//   keep-local    the local edit wins: it is restamped to NOW (desktop dto-service resolves by
//                 updatedAt, so the pushed row wins the next adjudication round) and pushed.
//   keep-incoming the peer row wins: it is applied verbatim (peer stamps preserved — it is
//                 already the LWW winner, nothing to push).
//   keep-both     the peer row is saved AGAINST A NEW LOCAL ID as a copy (never overwriting the
//                 local row) and the copy is pushed so the desktop learns it; the local row and
//                 the copy then co-exist on both sides (desktop dto-service APPLIED on the new id).
// Output: { apply: [{entity, row}], push: [{entity, row}], resolution } — the caller persists
// `apply` through repository.applyPulled and sends `push` through the existing push channel.
// Timestamps handed in via `now` keep this function deterministic and testable.

export const CONFLICT_CHOICES = Object.freeze(['keep-local', 'keep-incoming', 'keep-both'])

const titleOf = row => String(row?.content ?? row?.title ?? row?.name ?? row?.note ?? '')

export function resolveConflict(conflict, choice, { now = Date.now(), mintId = defaultMintId } = {}) {
  if (!conflict || !conflict.entity || conflict.id == null) throw new TypeError('conflict with entity and id required')
  if (!CONFLICT_CHOICES.includes(choice)) throw new TypeError('choice must be one of ' + CONFLICT_CHOICES.join(', '))
  const local = conflict.local
  const incoming = conflict.incoming
  if (!local && !incoming) throw new TypeError('conflict carries no sides')

  if (choice === 'keep-local') {
    if (!local) throw new TypeError('keep-local: conflict has no local side')
    const winner = { ...local, updatedAt: Math.max(now, Number(local.updatedAt || 0) + 1) }
    return { apply: [{ entity: conflict.entity, row: winner }], push: [{ entity: conflict.entity, row: winner }], resolution: 'kept-local' }
  }

  if (choice === 'keep-incoming') {
    if (!incoming) throw new TypeError('keep-incoming: conflict has no incoming side')
    return { apply: [{ entity: conflict.entity, row: incoming }], push: [], resolution: 'kept-incoming' }
  }

  // keep-both: the peer row lands as a NEW row (fresh id, fresh stamp) — the local row and the
  // peer's content then exist side by side on both devices after the next sync round.
  if (!incoming) throw new TypeError('keep-both: conflict has no incoming side')
  const copyId = mintId()
  const copy = { ...incoming, id: copyId, updatedAt: now, deleted: 0, deletedAt: 0 }
  if (conflict.entity === 'todos' || conflict.entity === 'categories') {
    copy.content = titleOf(incoming) ? titleOf(incoming) + '（副本）' : '副本'
  } else {
    copy.note = String(incoming?.note || '') + '（副本）'
  }
  return {
    apply: [{ entity: conflict.entity, row: copy }],
    push: [{ entity: conflict.entity, row: copy }],
    resolution: 'kept-both'
  }
}

function defaultMintId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** Sheet view model: both versions side by side with their timestamps (ux-contract conflict spec). */
export function conflictSides(conflict) {
  const local = conflict?.local
  const incoming = conflict?.incoming
  return {
    local: local ? { text: titleOf(local), updatedAt: Number(local.updatedAt || 0), deleted: Boolean(local.deleted || local.delete) } : null,
    incoming: incoming ? { text: titleOf(incoming), updatedAt: Number(incoming.updatedAt || 0), deleted: Boolean(incoming.deleted || incoming.delete) } : null,
  }
}
