/**
 * View/navigation registry (single source of truth) — the mapping route name -> sidebar icon/label/nav key is defined only here.
 * Previously the same list existed in 5+ places (SideNav x3, layout x2, ViewMoreMenu, the hand-written ui-smoke list), and missing a new page was a frequent incident.
 * Adding a main nav page: 1) add the route in router.js 2) register one row here 3) done. The dead key todo-list-recent (route no longer exists) was removed in the consolidation.
 */
export const NAV_ITEMS = [
  { route: 'todo-list-today', path: '/todo-list/today', navKey: 'today', icon: 'app://app/assets/img/icon-main-nav-today.svg', labelKey: 'statsH.layout.navToday' },
  { route: 'todo-list-today-x', path: '/todo-list/today-x', navKey: 'todayX', icon: 'app://app/assets/img/icon-main-nav-today.svg', labelKey: 'statsH.layout.navTodayX' },
  { route: 'todo-list-calendar', path: '/todo-list/calendar', navKey: 'calendar', icon: 'app://app/assets/img/icon-main-nav-calendar.svg', labelKey: 'statsE.SideNav.calendarNav' },
  { route: 'todo-list-todo-box', path: '/todo-list/todo-box', navKey: 'todoBox', icon: 'app://app/assets/img/icon-main-nav-todobox.svg', labelKey: 'statsE.SideNav.inboxNav' },
  // Completed promoted into the main nav (user-finalized): the counterpart of the todo box — one handles unfinished, the other finished; review = analysis, completed = archive
  { route: 'todo-list-completed', path: '/todo-list/completed', navKey: 'completed', icon: 'app://app/assets/img/icon-done.svg', labelKey: 'statsH.layout.navCompleted' },
  { route: 'todo-list-statistics', path: '/todo-list/statistics', navKey: 'statistics', icon: 'app://app/assets/img/icon-main-nav-statistics.svg', labelKey: 'statsE.SideNav.insightsNav' },
  { route: 'todo-list-habit', path: '/todo-list/habit', navKey: 'habit', icon: 'app://app/assets/img/icon-main-nav-habit.svg', labelKey: 'statsE.SideNav.habitsNav' },
  { route: 'todo-list-projects', path: '/todo-list/projects', navKey: 'projects', icon: 'app://app/assets/img/icon-main-nav-project.svg', labelKey: 'statsE.SideNav.projectsNav' }
]

/** Routes outside the main nav that still have their own page header title (search/completed/recycle bin etc.) */
export const ROUTE_NAV = {
  ...Object.fromEntries(NAV_ITEMS.map(n => [n.route, n.navKey])),
  'todo-list-search': 'search',
  'todo-list-recycle-bin': 'recycleBin'
}

/** Page paths the smoke test (ui-smoke 5.7 overflow gate) needs to traverse, derived from this registry; don't hand-write them in tests */
export const SMOKE_ROUTES = [
  ...NAV_ITEMS.map(n => n.path),
  '/todo-list/recycle-bin'
]

/** navKey -> page header title i18n key (source for layout.pageTitle) */
export const NAV_TITLE = {
  today: 'statsH.layout.navToday',
  todayX: 'statsH.layout.navTodayX',
  todoBox: 'statsH.layout.navTodoBox',
  statistics: 'statsH.layout.navStatistics',
  search: 'statsE.layout.searchPlaceholder',
  calendar: 'statsH.layout.navCalendar',
  completed: 'statsH.layout.navCompleted',
  recycleBin: 'statsH.layout.navRecycleBin'
}

/** Route name -> navKey; parameterized routes (category/tag/project/filter) get dynamic keys built by the caller with the id */
export function navKeyOfRoute (name) {
  return ROUTE_NAV[name] || null
}
