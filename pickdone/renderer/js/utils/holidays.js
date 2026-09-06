/**
 * Statutory holiday data (renderer-side ESM) — used by repeating tasks for "skip statutory holidays / statutory workdays only".
 * Data shape matches the existing holidayList convention: [{ dateString: 'YYYY-MM-DD', holiday: true|false }]
 *   holiday:true  = day off (rest)
 *   holiday:false = adjusted workday (originally a weekend but shifted to a working day)
 * Maintenance note: each year around Oct–Nov, after the State Council General Office publishes the next year's arrangement,
 * manually add next year's entries to HOLIDAY_DATA; years not covered are not skipped (keeps existing behavior), no guessing.
 * Adjusted workdays follow official notices — prefer missing an entry over getting it wrong.
 */
export const HOLIDAY_DATA = [
  // ---- 2025 (Guobanfamingdian [2024] No. 17) ----
  { dateString: '2025-01-01', holiday: true },
  { dateString: '2025-01-28', holiday: true }, { dateString: '2025-01-29', holiday: true }, { dateString: '2025-01-30', holiday: true },
  { dateString: '2025-01-31', holiday: true }, { dateString: '2025-02-01', holiday: true }, { dateString: '2025-02-02', holiday: true },
  { dateString: '2025-02-03', holiday: true }, { dateString: '2025-02-04', holiday: true },
  { dateString: '2025-01-26', holiday: false }, { dateString: '2025-02-08', holiday: false },
  { dateString: '2025-04-04', holiday: true }, { dateString: '2025-04-05', holiday: true }, { dateString: '2025-04-06', holiday: true },
  { dateString: '2025-05-01', holiday: true }, { dateString: '2025-05-02', holiday: true }, { dateString: '2025-05-03', holiday: true },
  { dateString: '2025-05-04', holiday: true }, { dateString: '2025-05-05', holiday: true },
  { dateString: '2025-04-27', holiday: false },
  { dateString: '2025-05-31', holiday: true }, { dateString: '2025-06-01', holiday: true }, { dateString: '2025-06-02', holiday: true },
  { dateString: '2025-10-01', holiday: true }, { dateString: '2025-10-02', holiday: true }, { dateString: '2025-10-03', holiday: true },
  { dateString: '2025-10-04', holiday: true }, { dateString: '2025-10-05', holiday: true }, { dateString: '2025-10-06', holiday: true },
  { dateString: '2025-10-07', holiday: true }, { dateString: '2025-10-08', holiday: true },
  { dateString: '2025-09-28', holiday: false }, { dateString: '2025-10-11', holiday: false },
  // ---- 2026 (Guobanfamingdian [2025], published 2025-11) ----
  { dateString: '2026-01-01', holiday: true }, { dateString: '2026-01-02', holiday: true }, { dateString: '2026-01-03', holiday: true },
  { dateString: '2026-02-15', holiday: true }, { dateString: '2026-02-16', holiday: true }, { dateString: '2026-02-17', holiday: true },
  { dateString: '2026-02-18', holiday: true }, { dateString: '2026-02-19', holiday: true }, { dateString: '2026-02-20', holiday: true },
  { dateString: '2026-02-21', holiday: true }, { dateString: '2026-02-22', holiday: true },
  { dateString: '2026-04-04', holiday: true }, { dateString: '2026-04-05', holiday: true }, { dateString: '2026-04-06', holiday: true },
  { dateString: '2026-05-01', holiday: true }, { dateString: '2026-05-02', holiday: true }, { dateString: '2026-05-03', holiday: true },
  { dateString: '2026-05-04', holiday: true }, { dateString: '2026-05-05', holiday: true },
  { dateString: '2026-06-19', holiday: true }, { dateString: '2026-06-20', holiday: true }, { dateString: '2026-06-21', holiday: true },
  { dateString: '2026-09-25', holiday: true }, { dateString: '2026-09-26', holiday: true }, { dateString: '2026-09-27', holiday: true },
  { dateString: '2026-10-01', holiday: true }, { dateString: '2026-10-02', holiday: true }, { dateString: '2026-10-03', holiday: true },
  { dateString: '2026-10-04', holiday: true }, { dateString: '2026-10-05', holiday: true }, { dateString: '2026-10-06', holiday: true },
  { dateString: '2026-10-07', holiday: true }
]

/** For store initialization: returns a copy to prevent callers mutating the constant */
export function getHolidayList () { return HOLIDAY_DATA.map(x => ({ ...x })) }
