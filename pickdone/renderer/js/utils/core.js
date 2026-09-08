/**
 * Core utilities — taskId generation / sort scores / field parsing / formatting
 * Rules aligned with the project's baseline reference analysis
 */
import i18n, { lookupMessage } from '../i18n/index.js'
// UMD globals (index.html script tags): read once at top level (node tests inject window first via setup.mjs, then import);
// when missing, the error is deferred to first call — no longer blowing up the import chain (audit S4)
function g (k) {
  if (typeof window !== 'undefined' && window[k]) return window[k]
  if (typeof globalThis !== 'undefined' && globalThis[k]) return globalThis[k]
  return null
}
export const dayjs = g('dayjs') || (() => { throw new Error('dayjs UMD global not loaded') })
const pinyin = g('pinyinPro') ? window.pinyinPro.pinyin : ((...a) => { throw new Error('pinyinPro not loaded') })
/** Fallback color when no category (same origin as CSS --brand; referenced uniformly wherever a category color is missing) */
export const DEFAULT_CAT_COLOR = '#0f9d8f'
/** Single definition of date/time format strings (dayjs format) — change display conventions only here */
const FMT_LOCALES = {
  'zh-CN': { cnDate: 'M月D日', cnMonth: 'YYYY年M月', cnFull: 'YYYY年M月D日' },
  'en-US': { cnDate: 'MMM D', cnMonth: 'MMM YYYY', cnFull: 'MMM D, YYYY' }
}
function fmtLocaleOf () {
  try { return localStorage.getItem('appLocale') || 'zh-CN' } catch (e) { return 'zh-CN' }
}
export const FMT = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  dateTime: 'YYYY-MM-DD HH:mm',
  dateSec: 'YYYY-MM-DD HH:mm:ss', // Per-second time span for focus records (full timestamp)
  // cn* series (legacy naming) emits formats per current language: the English UI no longer shows Chinese-style dates like "Aug 31" (8月31日)
  get cnDate () { return (FMT_LOCALES[fmtLocaleOf()] || FMT_LOCALES['zh-CN']).cnDate },
  get cnMonth () { return (FMT_LOCALES[fmtLocaleOf()] || FMT_LOCALES['zh-CN']).cnMonth },
  get cnFull () { return (FMT_LOCALES[fmtLocaleOf()] || FMT_LOCALES['zh-CN']).cnFull }
}

/** Snow point: tomato focus minutes → estimate */

/** taskId: tid_<userId><6 random chars>_<millisecond timestamp> */
const RAND_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function genTaskId (userId, now = Date.now()) {
  let r = ''
  for (let i = 0; i < 6; i++) r += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)]
  return `tid_${userId}${r}_${now}`
}
export function genTomatoId () { return `tmt_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` }

/** Sort score (midpoint insertion, fround precision aligned with project baseline).
 *  custom mode displays by taskSort descending: addToTop = above the max; appending to the bottom must go below the min (minS-512),
 *  the original midpoint algorithm landed inside (min,max) = new tasks inserted mid-list instead of at the bottom (2026-09-02 4th review P1) */
export function nextSort (addToTop, minS, maxS) {
  let s
  if (!minS && !maxS) s = 1024 // first element of the list, arbitrary baseline
  else if (addToTop) s = maxS + 512
  else s = minS - 512
  return Math.fround(s)
}

export const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
export function isImageName (n) {
  const e = String(n).split('.').pop().toLowerCase()
  return IMG_EXT.includes(e)
}
export function firstImageOfList (jsonText) {
  try {
    const arr = JSON.parse(jsonText || 'null')
    if (!Array.isArray(arr)) return null
    return arr.find(x => x && x.name && isImageName(x.name)) || arr[0] || null
  } catch { return null }
}
/** Whether all subtasks are complete (an empty list does not count as all complete) — shared by TodoItem and EditPanel */
export function allSubsDone (subs) {
  return Array.isArray(subs) && subs.length > 0 && subs.every(x => x && x.checked)
}
/** Whether the parent task's completion state should toggle in sync with subtask completion: returns the completion state the parent should have, or null if no change needed */
export function subsCompleteTarget (subs, curComplete) {
  const all = allSubsDone(subs)
  if (all && !curComplete) return true
  if (!all && curComplete) return false
  return null
}
/** Milliseconds in a day (named constant for 86400000, used uniformly across the project) */
export const DAY_MS = 86400000
/** Global error reporting: unified exit for store/utility layers without component context (currently console.error, may hook into toast later) */
export function reportError (where, err) {
  console.error('[todo:' + where + ']', err)
}
/**
 * "Reschedule overdue incomplete tasks to today": shared by the three list views (Category/Tag/Recent).
 * @returns { n, snap } — n = entries actually changed; snap = original-value snapshot for batchMoveWithUndo
 */
export async function rescheduleExpired (dispatch, todos, todayTs) {
  let n = 0
  const snap = []
  for (const t of todos) {
    if (!t.complete && t.dayStart && t.dayStart < todayTs) {
      snap.push({ id: t.taskId, dayStart: t.dayStart, todoTime: t.todoTime })
      // _deferViews: one view rebuild after the loop instead of one per row (each was an O(n) computeViews)
      await dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { dayStart: todayTs, todoTime: todayTs, _deferViews: true } })
      n++
    }
  }
  if (n) await dispatch('todo/computeViews')
  return { n, snap }
}
export function parseSubtasks (jsonText) {
  try {
    const v = JSON.parse(jsonText || 'null')
    if (typeof v === 'string') return JSON.parse(v)
    if (Array.isArray(v)) return v
  } catch {}
  return []
}
export function parseJSONSafe (t) { try { return t ? JSON.parse(t) : null } catch { return null } }

/* ---------- Pinyin helpers ---------- */
const pinyinCache = new Map()
export function toPinyinLower (s) {
  if (pinyinCache.has(s)) return pinyinCache.get(s)
  let out = ''
  try { out = pinyin(String(s), { toneType: 'none', type: 'array' }).join('').toLowerCase() } catch {}
  if (pinyinCache.size > 5000) pinyinCache.clear()
  pinyinCache.set(s, out)
  return out
}
export function hasChinese (s) { return /[\u4e00-\u9fa5]/.test(String(s)) }

/* ---------- Display formatting ---------- */
// Use i18n keys: the caller passes $t; utility functions don't depend on this
function interp (str, params) {
  if (!params) return str
  return String(str).replace(/\{(\w+)\}/g, (m, p) => params[p] !== undefined ? params[p] : m)
}

// Entry point for looking up words without component context (used by store/utils layers); falls back to the flat table when the instance is unavailable or the key misses
export function tt (k, params) {
  try {
    const v = i18n.global.t(k, params)
    if (v !== k) return v
  } catch (e) { /* instance unavailable (node unit tests etc.), fall back to the flat table */ }
  const f = lookupMessage(k)
  return f !== undefined ? interp(f, params) : k
}

// Display copy for the "range" enum values in settings (the values themselves are stable keys, must never be shown directly)
const RANGE_KEY = {
  today: 'statsE.SettingsModal.rangeToday',
  '7d': 'statsH.SettingsModal.range7d',
  '15d': 'statsH.SettingsModal.range15d',
  '30d': 'statsH.SettingsModal.range30d',
  '90d': 'statsH.SettingsModal.range90d'
}
/** Expired-range enum → day count: today/yesterday are semantic options, can't extract a number (would NaN-fallback), same criterion as daysRangeTs */
export function rangeDays (v, fallback = 7) {
  const t = String(v || '')
  if (t === 'today') return 1
  if (t === 'yesterday') return 2
  return parseInt(t.replace(/[^0-9]/g, ''), 10) || fallback
}

export function rangeLabel (v, $t) {
  const k = RANGE_KEY[v]
  if (!k) return v
  return $t ? $t(k) : tt(k)
}

export function formatDayLabel (ts, today = Date.now(), $t) {
  if (!ts) return ''
  const d = dayjs(ts); const t = dayjs(today)
  const diffDays = d.startOf('day').diff(t.startOf('day'), 'day')
  if (diffDays === 0) return $t ? $t('statsA.core.today') : '今天'
  if (diffDays === 1) return $t ? $t('statsA.core.tomorrow') : '明天'
  if (diffDays === 2) return $t ? $t('statsA.core.dayAfterTomorrow') : '后天'
  if (diffDays === -1) return $t ? $t('statsA.core.yesterday') : '昨天'
  const sameYear = d.year() === t.year()
  const md = $t ? $t('statsA.core.md', { m: d.month() + 1, d: d.date() }) : `${d.month() + 1}月${d.date()}日`
  return sameYear ? md : d.format(FMT.cnFull)
}

export function dateBadgeColor (todo, store) {
  // today green / overdue red / future gray-blue; grayed out when complete
  if (todo.complete) return 'var(--text-4)'
  const t = store?.state?.todo?.todayTimestamp || Date.now()
  const diff = dayjs(todo.todoTime).startOf('day').diff(dayjs(t).startOf('day'), 'day')
  if (!todo.todoTime) return 'var(--text-3)'
  if (diff < 0) return '#ce3a31'
  if (diff === 0) return '#457f0e'
  return 'var(--text-3)'
}

/* ---------- User ---- (offline local profile) ---------- */
const LS_USER = 'user'
export function loadLocalUser () {
  try {
    const u = JSON.parse(localStorage.getItem(LS_USER))
    if (u && u.userId) {
      // Old profiles baked the translated default name into storage (still showed the old language after switching); migrate to the default flag
      if (u.userAccount === 'offline@local' && !u.userRenamed) { u.userNameDefault = true; u.userName = '' }
      return u
    }
  } catch {}
  const u = {
    userId: 840001,
    deviceId: 'OFFLINE-DEVICE',
    deviceType: 'PC',
    createTime: Date.now(),
    userAccount: 'offline@local',
    userName: '',
    userNameDefault: true,
    head: null,
    vip: true,
    vipStatusText: '',
    vipDeadTime: 4819564723696,
    snow: 888,
    usedSnow: 0,
    tomatoGain: 0,
    taskCompleted: 0,
    token: 'local-offline-token',
    packageName: 'com.pickdone.app',
    appName: 'PickDone',
    channelCode: 'PC',
    versionCode: versionCodeOf(appVersion())
  }
  safeSet(LS_USER, JSON.stringify(u))
  return u
}

/** Single source for the app version number: Electron gets it injected via preload (main process app.getVersion()), browser hosts via shim */
export function appVersion () {
  return (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.version) || '0.0.0'
}

/** Version number encoding: x.y.z -> 0xyz0 (numeric code) */
export function versionCodeOf (v) {
  const main = String(v).split('-')[0]
  const parts = main.split('.').map(p => { const n = parseInt(p, 10); return n < 10 ? '0' + n : '' + n })
  return parseInt(parts.join('').padEnd(6, '0'), 10)
}


/** Safe localStorage write: doesn't throw on quota exceeded/private mode, only warns.
 *  Returns whether it actually persisted: callers (e.g. tomato persistState) trigger compensation paths (forced DB mirror) based on it; previously warn-only = silent corruption */
export function safeSet (key, value) {
  try { localStorage.setItem(key, value); return true } catch (e) { console.warn('[storage] write failed:', key, e); return false }
}

/** Read a :root CSS variable (Canvas scenarios like charts can't use var() directly, read at runtime) */
export function cssVar (name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { return '' }
}

/** 任务前置依赖解析:predecessors TEXT 列存 JSON 数组(前置 taskId);依赖功能(实验性,devMode 门控)的唯一渲染端解析口 */
export function parsePredecessors (v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { return [] }
}
