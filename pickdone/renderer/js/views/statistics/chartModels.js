/**
 * Pure chart/heatmap/timeline model builders extracted from StatisticsView.vue (2026-09-12 split, S1 pilot).
 * Zero behavior change: same inputs -> same render models as the former inline computeds.
 *
 * Conventions:
 *  - All functions are pure: data in, render model out. The wall clock is injected (`nowTick` / `now`)
 *    so tests are deterministic and the reactive-clock pattern of the parent computeds is preserved.
 *  - i18n: translation stays at the template/computed layer. Functions that must produce human text
 *    accept an injected `t(key, params)` translator; the i18n keys themselves remain in the statsA.*
 *    shard (no keys duplicated or moved).
 *  - `dayjs` / DAY_MS / FMT come from the shared core util, exactly as before.
 */
import { dayjs, DAY_MS, FMT } from '../../utils/core.js'

const T = 'statsA.StatisticsView.'

/**
 * Period bounds for the review window (end is an exclusive upper bound; "this week" runs up to now).
 * Mirrors the former `periodBounds` computed; `label` is resolved through the injected translator.
 */
export function periodBounds (period, customRange, nowTick, t) {
  const now = dayjs(nowTick)
  switch (period) {
    case 'lastWeek': {
      const s = now.subtract(1, 'week').startOf('isoWeek')
      return { start: +s, end: +s.add(7, 'day'), label: t(T + 'period_lastWeek') }
    }
    case 'thisMonth': return { start: +now.startOf('month'), end: +now, label: t(T + 'period_thisMonth') }
    case 'lastMonth': {
      const s = +now.subtract(1, 'month').startOf('month')
      const e = +now.startOf('month')
      return { start: s, end: e, label: t(T + 'period_lastMonth') }
    }
    case 'last7': return { start: +now.subtract(7, 'day').startOf('day'), end: +now, label: t(T + 'period_last7') }
    case 'last30': return { start: +now.subtract(30, 'day').startOf('day'), end: +now, label: t(T + 'period_last30') }
    case 'custom': {
      if (!customRange) return { start: +now.subtract(7, 'day').startOf('day'), end: +now, label: t(T + 'period_custom') }
      const s = +dayjs(customRange[0]).startOf('day')
      const e = +dayjs(customRange[1]).add(1, 'day').startOf('day') // end is an exclusive upper bound, covering the whole selected final day
      return { start: s, end: e, label: t(T + 'period_custom') }
    }
    default: return { start: +now.startOf('isoWeek'), end: +now, label: t(T + 'period_thisWeek') }
  }
}

/**
 * GitHub-style activity heatmap (half year 26 weeks / full year 52 weeks).
 * Mirrors the former `heatmap` computed: same level thresholds, same column/day-of-week layout,
 * same trailing-done streak semantics (a gap at the very last cell does not break the streak).
 */
export function buildHeatmap ({ todos, records, weeks, nowTick }) {
  const day = DAY_MS
  // 用响应式时钟 nowTick 而非 dayjs():跨零点停留时热力图窗口不冻结(同 periodBounds)
  const today = dayjs(nowTick).startOf('day')
  const end = +today.add(6 - ((today.day() + 6) % 7), 'day')
  const start = +dayjs(end).subtract(weeks * 7 - 1, 'day')
  const doneByDay = new Map(); const focusByDay = new Map()
  todos.forEach(todo => {
    if (!todo.complete || todo.delete) return
    const ts = todo.completedAt || todo.updateTime
    if (!ts) return
    const k = dayjs(ts).format(FMT.date)
    doneByDay.set(k, (doneByDay.get(k) || 0) + 1)
  })
  records.forEach(r => {
    if (r.succeed === false) return
    const k = dayjs(Number(r.endTime)).format(FMT.date)
    focusByDay.set(k, (focusByDay.get(k) || 0) + (r.focusDuration || 0))
  })
  const maxDone = Math.max(1, ...doneByDay.values())
  const cells = []
  for (let ts = start; ts <= end; ts += day) {
    const d = dayjs(ts)
    const k = d.format(FMT.date)
    const done = doneByDay.get(k) || 0
    const focus = focusByDay.get(k) || 0
    let level = 0
    if (done > 0) level = 1
    if (done >= maxDone * 0.34 || (done > 0 && focus >= 25)) level = 2
    if (done >= maxDone * 0.67 || (done > 0 && focus >= 50)) level = 3
    if (done >= maxDone || (done > 0 && focus >= 100)) level = 4
    cells.push({ key: k, date: d.format(FMT.cnFull), done, focus, level,
      col: Math.floor((ts - start) / day / 7), dow: (d.day() + 6) % 7 })
  }
  const totalDone = cells.reduce((s, c) => s + c.done, 0)
  const streak = (() => {
    let n = 0
    for (let i = cells.length - 1; i >= 0; i--) { if (cells[i].done > 0) n++; else if (i !== cells.length - 1) break }
    return n
  })()
  return { cells, weeks, totalDone, streak }
}

/** Give-ups in the trailing 7 days (heatmap header stat). */
export function countGiveUps7 (records, now = Date.now()) {
  const since = +dayjs(now).subtract(7, 'day').startOf('day')
  return records.filter(r => r.succeed === false && Number(r.endTime) >= since).length
}

/**
 * Weekday distribution model (Monday-Sunday, dual axis: bars = completed events / line = focus minutes).
 * Mirrors the former `weekdayModel` computed; label keys resolved through the injected translator.
 */
export function buildWeekdayModel (m, t) {
  const labels = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7'].map(k => t(T + k))
  return {
    modelType: 4,
    title: t(T + 'weekdayTitle'),
    subTitle: t(T + 'weekdaySubtitle'),
    chartList: labels.map((l, i) => ({ label: l, value: m.doneByWeekday[i] })),
    overlayList: labels.map((l, i) => ({ label: l, value: m.focusByWeekday[i] })),
    summary: t(T + 'weekdaySummary', { d: labels[m.focusByWeekday.indexOf(Math.max(...m.focusByWeekday))] || '—' })
  }
}

/**
 * Completion trend + baseline reference band (chart-c extended with a baselineValue dashed line).
 * Mirrors the former `trendModel` computed.
 */
export function buildTrendModel (m, t, subTitle) {
  const baseDaily = m.baseline.done
  return {
    modelType: 3,
    title: t(T + 'trendTitle'),
    subTitle,
    chartList: m.doneByDay,
    baselineValue: baseDaily == null ? null : +baseDaily.toFixed(2), // daily-average reference line
    summary: baseDaily == null ? t(T + 'trendSummaryEmpty') : t(T + 'trendSummaryBase', { n: baseDaily.toFixed(1) })
  }
}

/**
 * Focus trend (minutes): the second half of "event caliber + focus caliber" side by side,
 * baseline same as the focus KPI. Mirrors the former `focusTrendModel` computed.
 */
export function buildFocusTrendModel (m, t, subTitle) {
  const baseDaily = m.baseline.focus
  return {
    modelType: 3,
    title: t(T + 'focusTrendTitle'),
    subTitle,
    chartList: m.focusByDay,
    legendLabel: t(T + 'legendFocusMins'),
    baselineValue: baseDaily == null ? null : +baseDaily.toFixed(1),
    summary: baseDaily == null ? t(T + 'trendSummaryEmpty') : t(T + 'focusTrendSummary', { n: baseDaily.toFixed(1) })
  }
}

/**
 * 24-hour timeline: last 7 days. Empty rows compressed, segment boundaries clamped to the day,
 * fully duplicated records deduplicated, consecutive pomodoros (gap <= 10min) merged into session
 * bands. Mirrors the former `timelineRows` computed line for line.
 *
 * @param {object} p
 * @param {Array} p.records   tomatoRecordList
 * @param {Array} p.todos     todoList (for the per-day completed-events count)
 * @param {Function} p.t      injected translator: t(key, params) — keys stay in the statsA shard
 * @param {number} [p.now]    wall clock ms (defaults to Date.now()); injectable for tests
 */
export function buildTimelineRows ({ records, todos, t, now = Date.now() }) {
  const byDay = new Map()
  for (const r of records) {
    const end = Number(r.endTime) || 0
    if (!end) continue
    const key = dayjs(end).format(FMT.date)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(r)
  }
  const rows = []
  for (let d = 6; d >= 0; d--) {
    const dayStart = dayjs(now).startOf('day').valueOf() - d * DAY_MS
    const key = dayjs(dayStart).format(FMT.date)
    const segs = []
    let count = 0
    const seen = new Set() // fully identical records (same start/end, duration, task) drawn once: dirty historical data from multi-window races no longer stacks up
    let minutes = 0
    // Completed events that day (completion time falls on that date, same semantics as the heatmap)
    const done = todos.reduce((n, todo) => {
      if (!todo.complete || todo.delete) return n
      const ts = todo.completedAt || todo.updateTime
      return ts && dayjs(ts).format(FMT.date) === key ? n + 1 : n
    }, 0)
    const list = (byDay.get(key) || []).sort((a, b) => a.endTime - b.endTime)
    // Focus session aggregation: consecutive pomodoros with gaps <=10min merge into one session band (visually turns "alternating light/dark bricks" into "one work session";
    // dark within a band = focus, light = rest; band-level hover reports the whole session summary, block-level hover keeps per-pomodoro detail)
    const bands = []
    let bandCursor = null
    for (const r of list) {
      const end = Number(r.endTime)
      const focusMs = (Number(r.focusDuration) || 0) * 60000
      const restMs = (Number(r.restDuration) || 0) * 60000
      const fStart = end - focusMs
      if (r.succeed !== false) { minutes += Number(r.focusDuration) || 0; count++ }
      const dupKey = fStart + '|' + end + '|' + (r.focusDuration || 0) + '|' + (r.focus || '')
      if (seen.has(dupKey)) continue
      seen.add(dupKey)
      // One pomodoro = one integral unit: the focus body plus the adjacent rest tail (finalized by user: rest and focus belong to the same moment; splitting them hurts readability)
      const clamp = (v, w) => Math.max(0, Math.min(v, 100 - Math.min(w, 100)))
      const restW = restMs > 0 ? Math.min(restMs, 5 * 60000) / DAY_MS * 100 : 0
      const focusW = focusMs / DAY_MS * 100
      const uLeft = clamp((fStart - dayStart) / DAY_MS * 100, focusW + restW)
      const uWidth = focusW + restW
      const GAP = 10 * 60000 / DAY_MS * 100 // session split threshold: 10 minutes
      if (focusMs > 0) {
        // The hover explains what this focus session was about: report the linked task's name, otherwise show placeholder copy (finalized by user)
        const what = r.focus ? t(T + 'segAttach', { name: r.focus }) : t(T + 'segFree')
        const title = t(T + 'segFocus', { time: dayjs(fStart).format('HH:mm') + '–' + dayjs(end).format('HH:mm'), n: r.focusDuration }) + ' · ' + what + (restW ? ' + ' + t(T + 'segRest') : '')
        const seg = { key: r.tomatoId + '_u', kind: 'unit',
          left: uLeft, width: uWidth, ff: uWidth ? focusW / uWidth * 100 : 100,
          title, focus: r.focus || '' }
        segs.push(seg)
        if (bandCursor && uLeft - (bandCursor.left + bandCursor.width) <= GAP) {
          bandCursor.width = Math.max(bandCursor.width, uLeft + uWidth - bandCursor.left)
          bandCursor.segs.push(seg)
          bandCursor.n += 1
          if (!bandCursor.tasks.includes(r.focus || '')) bandCursor.tasks.push(r.focus || '')
          bandCursor.endMin = Math.max(bandCursor.endMin, end)
        } else {
          bandCursor = { left: uLeft, width: uWidth, segs: [seg], n: 1, tasks: [r.focus || ''], endMin: end, startMin: fStart }
          bands.push(bandCursor)
        }
      } else if (restW > 0) {
        segs.push({ key: r.tomatoId + '_r', kind: 'rest',
          left: clamp((end - dayStart) / DAY_MS * 100, restW), width: restW, title: t(T + 'segRest') })
      }
    }
    // Band-level summary: hovering a band reveals the whole work session (N pomodoros / start-end / deduped linked tasks)
    for (const b of bands) {
      const tasks = b.tasks.filter(Boolean)
      const what = tasks.length
        ? tasks.map(n => t(T + 'segAttach', { name: n })).join('、')
        : t(T + 'segFree')
      b.title = t(T + 'segFocus', {
        time: dayjs(b.startMin).format('HH:mm') + '–' + dayjs(b.endMin).format('HH:mm'), n: b.n
      }) + ' · ' + what
    }
    rows.push({ dateKey: key, segments: segs, bands, count, minutes, done, empty: segs.length === 0 })
  }
  return rows
}
