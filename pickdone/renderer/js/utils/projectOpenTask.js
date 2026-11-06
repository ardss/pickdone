/** pd20 P1 multi-view (2026-11-06) — the ONE project-page "open this task" path.
 *
 *  Every project-page row/card (handoff rows, board cards, timeline entries) must open the
 *  same EditPanel with the SAME store row. The byCategory cache can briefly lag a freshly
 *  synced row (external writes ride todos-changed → async refresh), so a miss refreshes the
 *  store once via the canonical todo/init and retries — the click is never a silent no-op.
 *  Extracted from ProjectHandoff.openTask so the board/timeline views share the exact
 *  behavior instead of re-implementing it. */
export async function openProjectTask (store, catId, taskId) {
  let raw = store.getters['todo/byCategory'](catId).find(t => t.taskId === taskId)
  if (!raw) {
    try { await store.dispatch('todo/init') } catch { /* keep the cache verdict */ }
    raw = store.getters['todo/byCategory'](catId).find(t => t.taskId === taskId)
  }
  if (raw) store.commit('ui/openEdit', raw)
  return !!raw
}
