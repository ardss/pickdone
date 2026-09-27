/**
 * Stats/day-bounds ops extracted verbatim from db.js (structure-size ratchet). Pure relocation:
 * db.js keeps thin delegates in OPS (`statsByDay: (...a) => statsOps.statsByDay(db, ...a)` and a
 * `_dayBounds` delegate preserving the internal op surface), so db.call behavior is unchanged.
 */
const dayjs = require('dayjs')

// Per-day task total/completed counts (by due date), plus completion counts by "completion day" (unaffected by due date)
// scheduledDay stores millisecond timestamps; callers may pass a YYYYMMDD integer (CLI), uniformly converted to a millisecond range
exports._dayBounds = ({ from, to }) => {
  const conv = v => {
    if (v == null) return null
    if (v >= 1e11) return v // already in milliseconds
    const s = String(v)
    const y = +s.slice(0, 4); const mo = +s.slice(4, 6); const d = +s.slice(6, 8)
    // F2/H2: digit-slicing a 9-11 digit Unix-seconds value (e.g. 1758000000) yields a
    // "valid but wrong" date (year 1757, month 00) that is NOT NaN and silently poisons stats.
    // Validate the sliced calendar fields; anything outside month 1-12 / day 1-31 is a USAGE error.
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) {
      throw new Error('[TodoDB] _dayBounds: ' + v + ' is not a parseable date (YYYYMMDD slices to month ' + mo + ', day ' + d + '), refusing to run BETWEEN a bogus range')
    }
    return new Date(y, mo - 1, d).getTime()
  }
  const f = conv(from)
  const t = conv(to)
  // F2 2026-09-15:new Date('垃圾').getTime()=NaN 可通过 == null 检查,SQL BETWEEN NaN 绑定成 NULL
  // → 静默恒空统计(CLI stats 场景下"空结果"比报错更骗人)。NaN = 调用方传了无法解析的日期,USAGE 错误如实上抛。
  for (const [name, v] of [['from', f], ['to', t]]) {
    if (v != null && Number.isNaN(v)) throw new Error('[TodoDB] _dayBounds: ' + name + ' is not a parseable date, refusing to run BETWEEN NaN (silent empty stats)')
  }
  // 终点=to 当日本地日末:用 dayjs 加一天再减 1ms,夏令时切换日(23/25h)不错位 1 小时(2026-09-05 终审 P2;固定 +86400000 只对中国时区成立)
  return [f == null ? null : f, t == null ? null : +dayjs(t).add(1, 'day').startOf('day') - 1]
}

exports.statsByDay = (db, { from, to }) => {
  const [f, t] = exports._dayBounds({ from, to })
  // P2 2026-09-17: null bounds used to bind SQL BETWEEN NULL → silently always-empty, unlike
  // tomatoByDay which substitutes open-ended sentinels. scheduledDay is a millisecond timestamp;
  // 0 / 8.64e15 bracket every representable day (same sentinel semantics as tomatoByDay's
  // '0000-00-00'/'9999-99-99'). The completion-day keys are YYYYMMDD integers: 0 / 99991231.
  const fLo = f == null ? 0 : f
  const tHi = t == null ? 8640000000000000 : t
  // B12 (P3 2026-09-24) planned 口径对齐渲染端 metrics.js windowCounts:
  //   ds = dayStart || (todoTime ? startOf(todoTime).day : 0) —— 纯 todoTime(无 scheduledDay)任务
  // 也要计入当日 planned。旧行集只按 scheduledDay 分组,这类任务从所有统计里消失。
  // 候选集 = scheduledDay 落界 OR (scheduledDay=0 且 scheduledAt 落界);时刻→当日的换算在 JS 侧用
  // dayjs startOf('day')(本地时区正确;SQL strftime/julianday 的 UTC 取整在非 UTC 时区错日)。
  // scheduledAt is the row column for the app-shape todoTime (see db-rows.rowToTodo).
  const raw = db.prepare(`SELECT scheduledDay dsRaw, scheduledAt, SUM(complete) done, COUNT(*) total FROM todos
    WHERE deleted=0 AND ((scheduledDay BETWEEN ? AND ?) OR (scheduledDay = 0 AND scheduledAt BETWEEN ? AND ?))
    GROUP BY scheduledDay, scheduledAt`).all(fLo, tHi, fLo, tHi)
  const byDay = new Map()
  for (const r of raw) {
    const ds = r.dsRaw || (r.scheduledAt ? +dayjs(r.scheduledAt).startOf('day') : 0)
    if (!ds) continue
    const cur = byDay.get(ds) || { ds, done: 0, total: 0 }
    cur.done += r.done || 0
    cur.total += r.total || 0
    byDay.set(ds, cur)
  }
  const rows = [...byDay.values()].sort((a, b) => a.ds - b.ds)
  // 完成日查询的边界须与 strftime 产出的 YYYYMMDD 同单位(2026-09-05 终审 P1:与毫秒边界 BETWEEN 恒假→恒空)
  const fKey = f == null ? 0 : Number(dayjs(f).format('YYYYMMDD'))
  const tKey = t == null ? 99991231 : Number(dayjs(t).format('YYYYMMDD'))
  // P3 2026-09-23 完成日口径对齐(与渲染端 metrics.js doneTsOf 一致): completedAt=0 的历史/异常完成行
  // 按 updateTime 兜底落日 — 旧 SQL `completedAt > 0` 把这类行从所有完成日统计里永久剔除,App 侧却计入
  const doneByCompletionDay = db.prepare(`SELECT CAST(strftime('%Y%m%d', COALESCE(NULLIF(completedAt,0), updatedAt)/1000, 'unixepoch', 'localtime') AS INTEGER) ds, COUNT(*) n
    FROM todos
    WHERE deleted=0 AND complete=1 AND COALESCE(NULLIF(completedAt,0), updatedAt) > 0
      AND CAST(strftime('%Y%m%d', COALESCE(NULLIF(completedAt,0), updatedAt)/1000, 'unixepoch', 'localtime') AS INTEGER) BETWEEN ? AND ?
    GROUP BY ds`).all(fKey, tKey)
  return { rows, doneByCompletionDay }
}

// 真实专注账:聚合 tomato_records 行表按 dateKey 求和(2026-09-04 起账本唯一事实源=行表,不再读 meta blob);
// 旧实现查 todos.focusMinutes(=预计番茄)导致"补录的专注在 stats 里恒为 0/缺天"
exports.tomatoByDay = (db, { from, to }) => {
  const [f, t] = exports._dayBounds({ from, to })
  const fKey = f == null ? null : dayjs(f).format('YYYY-MM-DD')
  const tKey = t == null ? null : dayjs(t).format('YYYY-MM-DD')
  // 2026-09-04 根修:账本迁 tomato_records 行表后聚合一跳完成
  // succeed=1 only: abandoned pomodoros are not focus time — same filter as the renderer's StatisticsView
  const rows = db.prepare(`SELECT dateKey ds, SUM(focusDuration) focus FROM tomato_records
    WHERE succeed = 1 AND deleted = 0 AND dateKey BETWEEN ? AND ? GROUP BY dateKey`).all(
      fKey ? fKey : '0000-00-00', tKey ? tKey : '9999-99-99')
  return rows.map(r => ({ ds: r.ds, focus: r.focus || 0 }))
}
