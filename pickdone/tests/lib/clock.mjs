/**
 * D4 时钟确定性 helper — 测试内「今天」的统一取值口径。
 *
 * 背景(2026-09 卫生债审计):17 处 `new Date()` 真实时钟构造 today,仅 4 文件有
 *   setHours(12,0,0,0) 正午护栏。风险在跨午夜/跨时区:模块顶层在 23:59:59.9 求值、
 *   断言在 00:00 后执行时,"今天"错位一天导致 flake。
 *
 * 口径:所有「今天」一律锚定当日正午(12:00 本地时区)——正午距任一午夜边界都有
 *   12 小时余量,进程跨午夜存活时错位窗口最小;需要午夜值(与 store 的 dayStart
 *   对齐)时由正午再归零到 00:00。跑法配套:node 启动时外部注入 TZ(UTC 与
 *   Asia/Shanghai 各一遍结果一致是本域回归口径),不要在进程内改 TZ(POSIX/Win32
 *   生效时机不一致)。
 *
 * 用法:
 *   const today0 = todayMidnightMs()      // 替代 (() => { const d = new Date(); d.setHours(0,0,0,0); return +d })()
 *   const key  = dayKeyOf()               // 'YYYY-MM-DD'(本地时区),替代 dayKey(new Date())
 *   const past = dayKeyOf(-14)            // 相对天数偏移
 */
export function todayNoon (offsetDays = 0) {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  if (offsetDays) d.setDate(d.getDate() + offsetDays)
  return d
}

export function todayMidnight (offsetDays = 0) {
  const d = todayNoon(offsetDays)
  d.setHours(0, 0, 0, 0)
  return d
}

export function todayMidnightMs (offsetDays = 0) {
  return +todayMidnight(offsetDays)
}

export function dayKeyOf (offsetDays = 0) {
  const d = todayNoon(offsetDays)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
