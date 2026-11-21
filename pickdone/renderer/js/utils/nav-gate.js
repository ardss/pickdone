/** Sidebar nav visibility gates (pure, unit-tested; consumed by SideNav's filteredNavOrder).
 *  Two-layer doctrine for the experimental surfaces: the developer-mode master switch AND the
 *  module's own switch must both be on (today-x, habit).
 *  [pd20 lane B 2026-11-07] Projects GRADUATED off the master gate: it rides its own switch
 *  alone and DEFAULT_SETTINGS ships showProjectsModule=true, so new users see the entry from a
 *  cold start. Existing blobs that persist showProjectsModule:false keep it hidden (an explicit
 *  preference is never overridden). The 2026-09-10 revert verdict covered the module while it
 *  was still raw; the pd20 cycle hardened ProjectView/overview/work-handoff, so the entry is a
 *  first-class surface now. Note: shared/settings-manifest.mjs (main-side mirror) still lists
 *  false — renderer's DEFAULT_SETTINGS wins on load, and renderer/js is this lane's boundary. */

export function visibleNavRoutes (st, order) {
  const s = st || {}
  let list = order
  if (!s.developerMode || s.showTodayXModule !== true) list = list.filter(n => n !== 'todo-list-today-x')
  if (!s.developerMode || !s.showHabitModule) list = list.filter(n => n !== 'todo-list-habit')
  if (!s.showProjectsModule) list = list.filter(n => n !== 'todo-list-projects')
  return list
}
