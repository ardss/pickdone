/**
 * Extracted verbatim from views/CalendarView.vue (structure-size ratchet).
 * Wraps loadSolarLunar() in the shape FullCalendar expects.
 */
import { loadSolarLunar } from './lunar.js'

const LUNAR = () => loadSolarLunar().then(m => {
  const sl = m.default || m
  // ISC-licensed solarlunar (the former js-calendar-converter was GPL, so the library had to be swapped); adapts IDayCn/IMonthCn fields so callers need zero changes
  return { calendar: { solar2lunar (y, mo, da) {
    const r = sl.solar2lunar(new Date(y, mo - 1, da))
    return r ? Object.assign({}, r, { IDayCn: r.dayCn, IMonthCn: r.monthCn }) : r
  } } }
})

export default LUNAR
