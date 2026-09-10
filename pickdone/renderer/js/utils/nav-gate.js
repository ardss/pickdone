/** Sidebar nav visibility gates (pure, unit-tested; consumed by SideNav's filteredNavOrder).
 *  Two-layer doctrine for experimental surfaces: the developer-mode master switch AND the
 *  module's own switch must both be on (today-x, habit). The projects module has graduated
 *  (2026-09-10): it rides on its own switch alone, so turning developer mode off no longer
 *  hides shipped project features (status field / milestones / today association). */

export function visibleNavRoutes (st, order) {
  const s = st || {}
  let list = order
  if (!s.developerMode || s.showTodayXModule !== true) list = list.filter(n => n !== 'todo-list-today-x')
  if (!s.developerMode || !s.showHabitModule) list = list.filter(n => n !== 'todo-list-habit')
  if (!s.showProjectsModule) list = list.filter(n => n !== 'todo-list-projects')
  return list
}
