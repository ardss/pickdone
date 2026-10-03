/**
 * [D15-A3] Ledger-record time anchor.
 *
 * Root cause this fixes: TaskAccountModal used to derive the editable start time by anchoring
 * `endTime - duration` to the END time's local midnight (`dayjs(endTime).startOf('day')`). For a
 * record that crosses midnight (23:50 -> 00:20) the start lives on the PREVIOUS day, so the
 * minutes-of-day went negative (-10), the time picker clamped it to 00:00, and a casual open+save
 * silently rewrote the record 10 minutes later. The anchor must be the START's day, making
 * startMin a well-formed 0-1439 minutes-of-day that round-trips losslessly:
 *   endTime' = day0(start) + startMin*60000 + dur*60000 === original endTime
 */
import { dayjs } from './core.js'

/** Split a ledger record's absolute start timestamp (endTime - focus duration) into its
 *  start-day local midnight (`day0`) plus minutes-of-day (`startMin`, always 0-1439). */
export function splitRecordStart (endTime, durMinutes) {
  const startTs = Number(endTime) - Number(durMinutes || 0) * 60000
  const day0 = dayjs(startTs).startOf('day').valueOf()
  return { startTs, day0, startMin: (startTs - day0) / 60000 }
}
