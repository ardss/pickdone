/* Dependency-graph helpers extracted from store/todo.js (2026-09-15 size-ratchet split).
 * FS semantics: a task is ready only when all predecessors are complete; wouldCycle is the
 * write-time DFS cycle guard (the CLI mirrors this helper — they share no code by design). */
import { parsePredecessors } from './core.js'

// ---- Task dependencies (experimental, developerMode gated) ----
// predecessors: JSON array of predecessor taskId strings, stored in a TEXT column (same pattern as subtasks)
// FS semantics: a task is ready only when all of its predecessors are complete. Write-time DFS cycle guard — both renderer store and CLI
// mirror this helper (they bypass each other and share no code).
// parsePredecessors lives in utils/core.js (shared with DepView)
function wouldCycle (list, taskId, newPreds) {
  const byId = {}
  for (const t of list) { if (!t.delete) byId[t.taskId] = t }
  byId[taskId] = Object.assign({}, byId[taskId] || { taskId }, { predecessors: JSON.stringify(newPreds) })
  const done = {}
  const visiting = {}
  const walk = id => {
    if (done[id]) return false
    if (visiting[id]) return true
    visiting[id] = true
    const t = byId[id]
    if (t) {
      for (const p of parsePredecessors(t.predecessors)) {
        if (byId[p] && walk(p)) return true
      }
    }
    visiting[id] = false; done[id] = true
    return false
  }
  return walk(taskId)
}
function isTaskReady (list, t) {
  const preds = parsePredecessors(t.predecessors)
  if (!preds.length) return true
  const byId = {}
  for (const x of list) { if (!x.delete) byId[x.taskId] = x }
  return preds.every(pid => { const p = byId[pid]; return !p || p.complete })
}

export { wouldCycle, isTaskReady }
