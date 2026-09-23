/**
 * Shared task-semantics core — the single source of truth for write semantics for both the UI renderer and the CLI
 * Ported from renderer/js/store/todo.js (toggleComplete / ensureNextRepeatInstance).
 * The repeat engine AND the renewal decision/computation live in shared/repeat-core.mjs (single
 * source for BOTH sides — the renderer's utils/repeat.js now delegates to the same module). This
 * file injects Node's dayjs and the solarlunar lib and re-exports the bound wrappers.
 * Alignment note (dw wave 2026-09-23): delegating to the shared engine is NOT behavior-neutral for
 * the main process — it picks up the renderer's month end-of-month clamp (effDay = min(md, dim);
 * the old `if (md > dim) continue` dropped the 31st in every short month) and the week branch's
 * weekday Set-dedupe. Both are pinned by regression tests.
 */
const dayjs = require('dayjs')
const isoWeek = require('dayjs/plugin/isoWeek')
dayjs.extend(isoWeek)

const {
  expandRepeatDates: coreExpandRepeatDates,
  nextRepeatInstance: coreNextRepeatInstance,
  isLastRepeatInstance,
  renewalCarryFields,
  makeLunarToSolar,
  REPEAT_DEFAULTS,
  normalizeRepeatType,
  normalizeYearType
} = require('../../../shared/repeat-core.mjs')

/** taskId: tid_<userId><6 random chars>_<ms timestamp> (charset aligned with renderer/js/utils/core.js) */
const RAND_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
function genTaskId (userId, now = Date.now()) {
  let r = ''
  for (let i = 0; i < 6; i++) r += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)]
  return `tid_${userId}${r}_${now}`
}

/* ================= Complete/undo (aligned with toggleComplete) ================= */
/**
 * Completing the main task also checks all its subtasks (isCompleteWithSubtasks, default true in settings).
 * The subtask list is stored as subtasks JSON: [{checked:boolean, ...}]; skip the cascade if the JSON is malformed.
 */
function completePatch (todo, { withSubtasks = true, completedAt } = {}) {
  const patch = { complete: true, completedAt: completedAt || Date.now() }
  if (withSubtasks) {
    try {
      const subs = JSON.parse(todo.subtasks || '[]')
      if (Array.isArray(subs) && subs.length && subs.some(s => !s.checked)) {
        patch.subtasks = JSON.stringify(subs.map(s => ({ ...s, checked: true })))
      }
    } catch { /* skip the cascade when the subtask JSON is malformed */ }
  }
  return patch
}

/* ================= Repeat engine + renewal (shared single source: shared/repeat-core.mjs) ================= */
// Lunar conversion (ISC solarlunar): the main process can require it directly (CJS); semantics aligned with the renderer's setLunarLib
let lunarLib = null
try { lunarLib = (r => r && r.default ? r.default : r)(require('solarlunar')) } catch { /* lunar branch safely skipped when the lib is missing */ }
const lunarToSolar = makeLunarToSolar(dayjs, lunarLib)
const DEPS = { dayjs, lunarToSolar }

/** Generate the repeat date series (including the first day), returns a dayjs array in ascending order */
function expandRepeatDates (baseTs, settings, holidayList = []) {
  return coreExpandRepeatDates(baseTs, settings, holidayList, DEPS)
}

/**
 * Repeat-group renewal computation (pure function): when the latest instance in the group is
 * completed, returns the next instance's {todoTime, reminderTime} per the rule; null otherwise.
 * @param completedTodo the task instance that was completed
 * @param group all active instances in the group (repeatId === rid and not deleted)
 * @param rule repeatSettingsV2 (from meta 'repeatRule:<rid>')
 */
function nextRepeatInstance (completedTodo, group, rule, holidayList = []) {
  return coreNextRepeatInstance(completedTodo, group, rule, holidayList, DEPS)
}

module.exports = {
  genTaskId, completePatch, expandRepeatDates, nextRepeatInstance, REPEAT_DEFAULTS, normalizeRepeatType, normalizeYearType,
  // single source with the renderer's utils/repeat.js (shared/repeat-core.mjs)
  isLastRepeatInstance, renewalCarryFields
}
