/** Sidebar nav visibility gates (pure, unit-tested; consumed by SideNav's filteredNavOrder).
 *  Two-layer doctrine for ALL experimental surfaces: the developer-mode master switch AND the
 *  module's own switch must both be on (today-x, habit, projects). Projects stays under the
 *  master gate — the module is still experimental (user verdict 2026-09-10: "还没搞定"); a
 *  previous attempt to graduate it onto its own switch alone was reverted in the same sitting. */

export function visibleNavRoutes (st, order) {
  const s = st || {}
  let list = order
  if (!s.developerMode || s.showTodayXModule !== true) list = list.filter(n => n !== 'todo-list-today-x')
  if (!s.developerMode || !s.showHabitModule) list = list.filter(n => n !== 'todo-list-habit')
  if (!s.developerMode || !s.showProjectsModule) list = list.filter(n => n !== 'todo-list-projects')
  return list
}
