/**
 * Insights · metric extraction layer —— extracts period metrics and the personal baseline from Vuex data.
 * Pure functions with no component dependencies for easy unit testing; insights.js consumes this layer's output.
 *
 * Input sources:
 *   todos   — store.todo.todoList (complete/completedAt/updateTime/createTime/dayStart/categoryId/delete)
 *   records — store.tomato.tomatoRecordList (endTime/focusDuration/restDuration/succeed/focusTaskId)
 *   catNameOf(categoryId) — category id -> name (the caller falls back to "uncategorized" when there is none)
 * Period: { start, end, label }, where start/end are millisecond timestamps and end is an exclusive upper bound.
 */
import { dayjs, DAY_MS, FMT } from '../../utils/core.js'

/** Unified completion timestamp semantics: completedAt takes priority (updateTime gets polluted by later edits) */
export function doneTsOf (t) {
  return t.completedAt || t.updateTime || 0
}

export function dayKey (ts) {
  return dayjs(ts).format(FMT.date)
}

/** Raw counts for a single window: only filtering and summing, no comparison judgments */
export function windowCounts (todos, records, catNameOf, start, end) {
  let done = 0; let added = 0; let planned = 0; let plannedDone = 0
  const doneByDay = new Map(); const focusByDay = new Map()
  const hourDist = new Array(24).fill(0)
  const catFocus = new Map(); const catDone = new Map()
  let focusMins = 0; let tomatoCount = 0; let giveUps = 0
  const doneByWeekday = new Array(7).fill(0)   // Monday=0 ... Sunday=6
  const focusByWeekday = new Array(7).fill(0)
  const taskFocus = new Map() // taskId -> focus minutes ('_free' = unlinked free focus)
  const giveupNotes = []      // { label: 'MM/DD', text } abandon-modal reasons within the period
  let bestFocusDay = null   // { label, mins }
  let bestDoneDay = null    // { label, count }

  for (const t of todos) {
    if (t.delete) continue
    const ds = t.dayStart || (t.todoTime ? +dayjs(t.todoTime).startOf('day') : 0)
    if (ds >= start && ds < end) {
      planned++
      if (t.complete) plannedDone++
    }
    if (t.complete) {
      const ts = doneTsOf(t)
      if (ts >= start && ts < end) {
        done++
        const k = dayKey(ts)
        doneByDay.set(k, (doneByDay.get(k) || 0) + 1)
        const wd = (dayjs(ts).day() + 6) % 7
        doneByWeekday[wd]++
        const c = catNameOf(t.categoryId)
        catDone.set(c, (catDone.get(c) || 0) + 1)
      }
    }
    if (t.createTime >= start && t.createTime < end) added++
  }
  for (const [k, n] of doneByDay) {
    if (!bestDoneDay || n > bestDoneDay.count) bestDoneDay = { label: k.slice(5).replace('-', '/'), count: n }
  }

  for (const r of records) {
    const endTs = Number(r.endTime) || 0
    if (!endTs || endTs < start || endTs >= end) continue
    if (r.succeed === false) {
      giveUps++
      const reason = (r.abandonReason || '').trim()
      if (reason) giveupNotes.push({ label: dayjs(endTs).format('MM/DD'), text: reason })
      continue
    }
    const mins = r.focusDuration || 0
    focusMins += mins
    tomatoCount++
    const k = dayKey(endTs)
    focusByDay.set(k, (focusByDay.get(k) || 0) + mins)
    hourDist[new Date(endTs).getHours()] += mins
    const wd = (dayjs(endTs).day() + 6) % 7
    focusByWeekday[wd] += mins
    // focusTaskId is a task id; the task must be looked up first to get its category id (catNameOf expects a categoryId)
    const focusTask = todos.find(t => t.taskId === r.focusTaskId)
    const c = catNameOf(focusTask ? focusTask.categoryId : 0)
    catFocus.set(c, (catFocus.get(c) || 0) + mins)
    // Task-level focus aggregation (task ranking; unlinked focus goes into the '_free' bucket)
    const tk = r.focusTaskId || '_free'
    taskFocus.set(tk, (taskFocus.get(tk) || 0) + mins)
  }
  for (const [k, mins] of focusByDay) {
    if (!bestFocusDay || mins > bestFocusDay.mins) bestFocusDay = { label: k.slice(5).replace('-', '/'), mins }
  }

  return { done, added, planned, plannedDone, doneByDay, focusByDay, doneByWeekday, focusByWeekday, hourDist, catFocus, catDone, focusMins, tomatoCount, giveUps, taskFocus, giveupNotes, bestFocusDay, bestDoneDay }
}

/** Map -> descending [{label, value}] */
export function topEntries (map, n = 6) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([label, value]) => ({ label, value }))
}

/**
 * Period metrics + personal baseline.
 * Baseline = the "daily average" over the 4 adjacent equal-length windows before the current period (daily-average semantics naturally tolerate incomplete periods,
 * e.g. "this week" only being at Wednesday won't be compared against a full week's total).
 */
export function buildReviewMetrics ({ todos, records, catNameOf }, period) {
  const { start, end, label } = period
  // days stays in milliseconds terms (last 7 days = 7; a calendar difference including today would give 8); DST protection only for calendar math on window endpoints/series/streaks
  const days = Math.max(1, Math.round((end - start) / DAY_MS))
  const cur = windowCounts(todos, records, catNameOf, start, end)

  // Baseline: the 4 adjacent equal-length windows (each = `days` days); endpoints uniformly anchored at start. Window endpoints use dayjs calendar math:
  // millisecond multiplication drifts 1 hour across DST switch days, misaligning window slots with dayKeys (completions counted into an adjacent day)
  const prev = []
  for (let i = 1; i <= 4; i++) {
    const a = +dayjs(start).subtract(i * days, 'day').startOf('day')
    const b = +dayjs(start).subtract((i - 1) * days, 'day').startOf('day')
    prev.push(windowCounts(todos, records, catNameOf, a, b))
  }
  const avg = key => {
    const vals = prev.map(p => p[key] / days)
    const any = prev.some(p => p[key] > 0)
    return any ? vals.reduce((s, v) => s + v, 0) / vals.length : null // all-zero history returns null = no baseline
  }
  const rate = w => w.planned ? w.plannedDone / w.planned : null
  const baseRates = prev.map(rate).filter(v => v != null)
  // Baseline validity: history windows must have real activity (any window with completions or focus), otherwise "about the same as before" is empty talk
  const hasHistory = prev.some(p => p.done > 0 || p.focusMins > 0)
  const baseline = {
    done: hasHistory ? avg('done') : null,
    focus: hasHistory ? avg('focusMins') : null,
    giveUps: hasHistory ? avg('giveUps') : null,
    doneRate: baseRates.length ? baseRates.reduce((s, v) => s + v, 0) / baseRates.length : null,
    hasHistory
  }

  // Consecutive completion days (up to today; today being unfinished doesn't break the streak)
  // Consecutive completion days: based on the full completion records (not truncated by the current period window); today being unfinished doesn't break the streak
  const doneDays = new Set()
  for (const t of todos) {
    if (t.delete || !t.complete) continue
    const ts = doneTsOf(t)
    if (ts) doneDays.add(dayKey(ts))
  }
  let streak = 0
  // Streak walks back day by day using calendar math: on DST spring-forward days Date.now()-i*DAY yields a previous-day 23:xx key, breaking the streak early
  for (let i = doneDays.has(dayKey(Date.now())) ? 0 : 1; i < 365; i++) {
    if (doneDays.has(dayKey(+dayjs().subtract(i, 'day').startOf('day')))) streak++
    else break
  }

  // Peak hours: 2-hour sliding window sum, take the peak
  let peak = null
  const totalFocus = cur.focusMins
  if (totalFocus >= 30) {
    let bestSum = -1; let bestH = 0
    for (let h = 0; h < 24; h++) {
      const s = cur.hourDist[h] + cur.hourDist[(h + 1) % 24] + cur.hourDist[(h + 2) % 24]
      if (s > bestSum) { bestSum = s; bestH = h }
    }
    if (bestSum > 0) peak = { startHour: bestH, endHour: (bestH + 3) % 24, share: Math.round(bestSum / totalFocus * 100) }
  }

  const byDaySeries = map => {
    const out = []
    for (let i = 0; i < days; i++) {
      const d = dayjs(start).startOf('day').add(i, 'day')
      out.push({ label: d.format('MM/DD'), value: map.get(dayKey(+d)) || 0 })
    }
    return out
  }

  // Cross-metric: focus vs completion by day (same key space). Threshold 25 minutes = one full pomodoro counts as a "focus day".
  const dayKeys = new Set([...cur.doneByDay.keys(), ...cur.focusByDay.keys()])
  let focusNoDoneDays = 0   // had focus but no completion record (checking off tasks forgotten or fragmented focus)
  let focusDays = 0; let doneOnFocusDays = 0
  let noFocusDays = 0; let doneOnNoFocusDays = 0
  for (const k of dayKeys) {
    const f = cur.focusByDay.get(k) || 0
    const d = cur.doneByDay.get(k) || 0
    if (f >= 25) { focusDays++; doneOnFocusDays += d; if (d === 0) focusNoDoneDays++ }
    else if (d > 0) { noFocusDays++; doneOnNoFocusDays += d }
  }

  return {
    label, start, end, days,
    done: cur.done,
    added: cur.added,
    planned: cur.planned,
    doneRate: cur.planned ? cur.plannedDone / cur.planned : null,
    focusMins: cur.focusMins,
    tomatoCount: cur.tomatoCount,
    giveUps: cur.giveUps,
    doneByDay: byDaySeries(cur.doneByDay),
    focusByDay: byDaySeries(cur.focusByDay),
    hourDist: cur.hourDist,
    doneByWeekday: cur.doneByWeekday,
    focusByWeekday: cur.focusByWeekday,
    bestFocusDay: cur.bestFocusDay,
    bestDoneDay: cur.bestDoneDay,
    catFocus: topEntries(cur.catFocus),
    catDone: topEntries(cur.catDone),
    taskFocus: topEntries(cur.taskFocus),
    giveupNotes: cur.giveupNotes.slice(0, 4),
    focusNoDoneDays,
    focusDaysAvgDone: focusDays ? doneOnFocusDays / focusDays : null,
    noFocusDaysAvgDone: noFocusDays ? doneOnNoFocusDays / noFocusDays : null,
    peakHours: peak,
    baseline,
    streak
  }
}

/** Relative difference percentage (cur vs baseline daily average); returns null without a baseline; clamped to ±199% */
export function pctDiff (cur, base) {
  if (base == null || base === 0) return null
  return Math.max(-199, Math.min(199, Math.round((cur - base) / base * 100)))
}
