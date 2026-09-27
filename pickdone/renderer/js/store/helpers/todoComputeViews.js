/**
 * computeViews implementation, extracted verbatim from store/todo.js (structure-size ratchet).
 * Pure relocation: the action is now a thin wrapper (`computeViews (ctx) { return computeViewsCore(this, ctx) }`),
 * and tests that drive the action with a fake `this` keep working unchanged (the store/fake-this
 * is passed in as the first argument). Grouping semantics are unchanged.
 */
import { dayjs, DAY_MS } from '../../utils/core.js'
import { sortByMode } from '../../utils/sortMode.js'
import { getEstimate } from '../../utils/tomatoEstimate.js'
import { daysRangeTs } from './todoPendingUpserts.js'
import { showNoDateFilter, buildCalendarList } from './todoViews.js'

export function computeViewsCore (store, { commit, rootState, dispatch }) {
  // After crossing midnight, keep the global todayTimestamp consistent with the grouping basis (main.js dirt-checks every 60s)
  commit('setTodayTs', Date.now())
  dispatch('purgeExpiredRecycle')
  const settings = rootState.settings
  const { expCompletedDays, expUncompletedDays, upcomingDays } = daysRangeTs(settings)
  const today = dayjs().startOf('day').valueOf()
  const live = store.state.todo.todoList.filter(t => !t.delete)

  const recentExpiredCompleted = []
  const recentExpiredUncompleted = []
  const todayList = []
  const tomorrowList = []
  const after2List = []
  const upcomingList = []
  const noDateList = []
  const todayDoneList = []
  // Round-3 perf (ux-perf-finding-10): precompute TodayXView's two groups here (sorted later
  // with the exact comparator the view used inline: dayStart, then todoTime). x-next = today +
  // ALL overdue uncompleted (UNCAPPED — cannot reuse recent.expiredUncompleted); x-open = the
  // no-date uncompleted set, always shown (unlike recent.noDate, gated by showNoDate).
  const todayXNext = []

  live.forEach(t => {
    const ds = t.dayStart
    // Review P3 (2026-09-22): NaN dayStart (corrupted date parse) must degrade to the no-date
    // bucket — NaN is falsy but previously still slipped into the `t.dayStart &&` checks below
    // inconsistently; normalize once so the bucketing and comparators stay total.
    const dsNum = (typeof ds === 'number' && Number.isFinite(ds)) ? ds : 0
    if (!dsNum) {
      // Completed no-date tasks go into "today completed" (otherwise completing one makes it vanish from the today page with no way to un-complete in place)
      if (t.complete) {
        const ct = t.completedAt || t.updateTime || 0
        if (ct >= today && ct < +dayjs(today).add(1, 'day')) todayDoneList.push(t)
        else noDateList.push(t)
      } else {
        noDateList.push(t)
      }
      return
    }
    if (t.complete) {
      // "Today completed" groups by completion time (completedAt, falling back to updateTime), not the original due date:
      // a task due yesterday but completed today belongs in today completed (where it can be un-completed), not vanished into history
      const ct = t.completedAt || t.updateTime || 0
      if (ct >= today && ct < +dayjs(today).add(1, 'day')) todayDoneList.push(t)
      return
    }
    const diff = Math.round((dsNum - today) / DAY_MS)
    if (diff < 0) {
      if (-diff <= expUncompletedDays) recentExpiredUncompleted.push(t)
      todayXNext.push(t)
    } else if (diff === 0) { todayList.push(t); todayXNext.push(t) } else if (diff === 1) tomorrowList.push(t)
    else if (diff === 2) after2List.push(t)
    else if (diff <= upcomingDays) upcomingList.push(t)
  })

  // Expired completed: overdue tasks completed within the last N days (counted by completion time completedAt).
  // D5 (2026-09-20): exclude tasks already in todayDoneList — an overdue task completed TODAY landed in
  // both groups (grouping is by completion time in one loop and by due date in the other), showing once
  // in "today done" and again in "recent expired completed" (double un-complete entries).
  const completedCutoff = +dayjs(today).subtract(expCompletedDays, 'day')
  const todayDoneIds = new Set(todayDoneList.map(t => t.taskId))
  live.forEach(t => {
    const doneTs = t.completedAt || t.updateTime || 0
    if (t.complete && t.dayStart && t.dayStart < today && doneTs >= completedCutoff && !todayDoneIds.has(t.taskId)) {
      recentExpiredCompleted.push(t)
    }
  })

  const completedList = live.filter(t => t.complete)
    .sort((a, b) => (b.completedAt || b.updateTime || 0) - (a.completedAt || a.updateTime || 0))

  // Todo box: no-date incomplete
  let box = noDateList.filter(t => !t.complete)
  const todayXOpen = box.slice() // TodayX "Unscheduled" group: same set, unsorted, no category filter (TodayX always shows it)
  if (settings.todoBoxCategoryId !== -1) box = box.filter(t => t.categoryId === settings.todoBoxCategoryId)
  const dir = settings.todoBoxSortOrder === 'asc' ? 1 : -1
  // Review P3 (2026-09-22): NaN-safe comparators — a NaN createTime/todoTime used to make the
  // subtraction comparator return NaN (implementation-defined order); missing numbers now fall
  // back to 0 so rows keep a deterministic position instead of reshuffling every recompute.
  const tsOf = t => (typeof t.createTime === 'number' && Number.isFinite(t.createTime)) ? t.createTime : 0
  const dueOf = t => (typeof (t.todoTime || t.createTime) === 'number' && Number.isFinite(t.todoTime || t.createTime)) ? (t.todoTime || t.createTime) : 0
  box.sort((a, b) => {
    switch (settings.todoBoxSortMethod) {
      case 'due': return (dueOf(a) - dueOf(b)) * dir
      case 'difficulty': return (getEstimate(a.taskId) - getEstimate(b.taskId)) * dir // Difficulty retired: by estimated workload = estimated tomatoes
      default: return (tsOf(a) - tsOf(b)) * dir
    }
  })

  // Sort mode: stable-key normalization + comparator extracted to utils/sortMode.js (pure function, unit-testable)
  const applySort = arr => sortByMode(arr, settings.sortMode)

  // Yesterday's unfinished (day-rollover leftovers)
  const yesterday = live.filter(t => !t.complete && t.dayStart === +dayjs(today).subtract(1, 'day'))

  commit('setViews', {
    recent: {
      expiredCompleted: recentExpiredCompleted.sort((a, b) => a.dayStart - b.dayStart),
      expiredUncompleted: recentExpiredUncompleted.sort((a, b) => a.dayStart - b.dayStart),
      today: applySort(todayList),
      tomorrow: tomorrowList,
      dayAfterTomorrow: after2List,
      upcoming: upcomingList,
      noDate: showNoDateFilter(noDateList.filter(t => !t.complete), settings)
    },

    todayTodoList: applySort(todayList),
    todayXNext: todayXNext.sort((x, y) => (x.dayStart - y.dayStart) || (x.todoTime - y.todoTime)),
    todayXOpen,
    // Completed-group sort matches the grouping basis (completedAt first, avoiding sort misplacement when editing after completion)
    // [nan-comparator fix] same ||0 fallback as the Review-P3 (2026-09-22) comparators above —
    // a completed row with NaN completedAt/updateTime made this subtraction return NaN
    // (implementation-defined order, rows reshuffling every recompute); recycleBin had the
    // same gap on deletedAt/updateTime.
    todayDoneList: todayDoneList.sort((a, b) => (b.completedAt || b.updateTime || 0) - (a.completedAt || a.updateTime || 0)),
    yesterdayTodoList: yesterday,
    calendar: buildCalendarList(live),
    todoBox: box,
    todoBoxCount: box.length, // Same source as box above (category filter/sort share one chain); previously computed independently here too — fixing one but not the other made the number and list disagree
    completed: completedList,
    recycleBin: [...store.state.todo.recycleList].sort((a, b) => (b.deletedAt || b.updateTime || 0) - (a.deletedAt || a.updateTime || 0))
  })
  commit('viewsClean')
}
