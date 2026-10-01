/** EditPanel remote-update guard (F3, 2026-09-20 sync UI visibility round).
 *
 *  The panel used to hydrate once on open; inbound LAN-sync changes to the open task never
 *  re-hydrated, so the next autosave clobbered the peer's edit with the stale snapshot.
 *
 *  Pure helpers here (unit-tested); the component owns the policy:
 *    - contentFingerprint: stable fingerprint of the core editable fields shared identically by
 *      the live todo-store row and the panel's local snapshot (subtasks/attachments have
 *      different shapes on each side — parsed rows vs render lists — so they are excluded).
 *    - shouldRefreshRemote: decides whether an inbound row change is material relative to what
 *      the panel hydrated from. Returns 'none' when nothing material changed (no row, same
 *      updateTime, or the fingerprint is unchanged — e.g. the change was the panel's own save
 *      echoing back). Returns 'changed' when a peer edit arrived.
 *
 *  Component policy on 'changed': if the user has NOT typed anything since hydration
 *  (panel fingerprint === hydrated fingerprint) the panel silently re-hydrates; if the user HAS
 *  edited, an inline "content updated on another device" notice with a manual refresh button is
 *  shown instead — user input is never auto-overwritten.
 *
 *  Also hosts taskAbsentIn — the verified-absence check EditPanel's auto-close guard must pass
 *  before closing the panel (P1 2026-10-01 round). The shared panel-snapshot builder
 *  (buildEditSnapshot, used by BOTH ui/openEdit and EditPanel.hydrate) lives in store/ui.js —
 *  this module stays dependency-free (round6-qc-fixes imports it without the test DOM setup). */

// Each entry: [panel-snapshot key, live store-row key]. The baseline is fingerprinted from the
// panel snapshot (title/desc/dateTs/...), but checkRemoteUpdate receives the RAW todo-store row
// (taskContent/taskDescribe/todoTime/...). Round-6 P2: comparing one vocabulary against the other
// made every live-row fingerprint '' -fields and the own-save echo branch dead — the verdict was
// effectively "updateTime changed", cry-wolfing the stale banner on every inbound round.
/* P0 root fix (2026-09-25): the panel snapshot vocabulary now has a single source. ui/openEdit
 * builds its snapshot from PANEL_FIELD_MAP, contentFingerprint reads the panel keys of the same
 * map, and the shape test (tests/unit/components/editpanel-behavior.test.mjs) asserts the snapshot
 * key set covers every field EditPanel reads off `e`. Before, openEdit dropped deadlineTs/
 * priority/important: the deadline row showed "设置截止日" with a dead clear button (EditPanel.vue
 * reads e.deadlineTs), and the panel-side fingerprint was forever missing those keys so
 * shouldRefreshRemote could never recognize the panel's own save echo. */
export const PANEL_FIELD_MAP = [
  // [panel-snapshot key, live store-row key, default when the row lacks the field]
  ['title', 'taskContent', ''],
  ['desc', 'taskDescribe', ''],
  ['dateTs', 'todoTime', 0],
  ['remindTs', 'reminderTime', 0],
  ['reminderOffsets', 'reminderOffsets', null], // array — ui.js slices it
  ['reminderExtra', 'reminderExtra', null],     // array — ui.js slices it
  ['categoryId', 'categoryId', 0],
  ['repeatId', 'repeatId', null],
  ['deadlineTs', 'deadlineTs', 0],
  ['priority', 'priority', 0],
  ['important', 'important', 0],
  ['sublist', 'subtasks', null],       // parsed from JSON — ui.js maps it
  ['todoImageList', 'image', null],    // parsed from JSON — ui.js maps it
  ['fileList', 'files', null]          // parsed from JSON — ui.js maps it
]

const FINGERPRINT_FIELDS = [
  ['title', 'taskContent'],
  ['desc', 'taskDescribe'],
  ['dateTs', 'todoTime'],
  ['remindTs', 'reminderTime'],
  ['priority', 'priority'],
  ['important', 'important'],
  ['categoryId', 'categoryId'],
  // [uiux-2026-10-01 J3 P2] repeatId joins the fingerprint: RepeatModal.generate stamps the
  // template task with the new group's repeatId while its edit panel is open; without it the
  // inbound change classifies as a non-core own-save echo (verdict 'none') and the panel keeps
  // showing "设置重复" with no way back into the rule from the task it was created on.
  ['repeatId', 'repeatId']
]

/** Panel-snapshot keys the own-save-echo fingerprint depends on. Exported for the shape
 *  consistency test: every one of these MUST be present in the openEdit snapshot. */
export const FINGERPRINT_PANEL_KEYS = FINGERPRINT_FIELDS.map(([k]) => k)

/** Default applied when BOTH the panel key and the row key are absent. Pulled from
 *  PANEL_FIELD_MAP so the fingerprint vocabulary cannot drift from the snapshot builder:
 *  browser-shim rows lack priority/important (the desktop db layer normalizes them at
 *  db-rows.js), and the openEdit snapshot defaults those to 0 — fingerprinting the missing
 *  row as '' while the panel baseline says 0 made every own-save echo classify as a peer
 *  edit (P1 2026-10-01: pristine re-hydrates discarded just-added subtasks mid-panel). */
const PANEL_DEFAULTS = Object.fromEntries(PANEL_FIELD_MAP.map(([panelKey, , dflt]) => [panelKey, dflt]))

/** Fingerprint of the core editable fields (order-stable, tolerant of missing rows; accepts both
 *  the panel snapshot shape and the raw store row). Missing fields normalize to the same default
 *  the snapshot builder would have applied. */
export function contentFingerprint (t) {
  if (!t || typeof t !== 'object') return ''
  const parts = []
  for (const [panelKey, rowKey] of FINGERPRINT_FIELDS) {
    let v = t[panelKey] !== undefined && t[panelKey] !== null ? t[panelKey] : t[rowKey]
    if (v === undefined || v === null) v = PANEL_DEFAULTS[panelKey] !== undefined ? PANEL_DEFAULTS[panelKey] : ''
    parts.push(`${panelKey}=${String(v)}`)
  }
  return parts.join('|')
}

/** Material-change verdict for an inbound store row vs the panel's hydration baseline. */
export function shouldRefreshRemote ({ baseFingerprint, baseUpdateTime, row }) {
  if (!row || typeof row !== 'object') return 'none'
  if (Number(row.updateTime) === Number(baseUpdateTime)) return 'none'
  if (contentFingerprint(row) === baseFingerprint) return 'none' // own-save echo / non-core change
  return 'changed'
}

/** Verified absence: the task is in NEITHER the active list NOR the recycle bin. Used by
 *  EditPanel's auto-close guard so a transient null during todo/init#setAllRows (full reload
 *  replacing the row array) no longer reads as "task deleted by another window" and slams the
 *  panel shut mid-edit (P1 2026-10-01: picking a deadline during the reload window closed the
 *  panel and lost the edit). */
export function taskAbsentIn (todoState, taskId) {
  if (!taskId) return false
  const st = todoState || {}
  // Neither list readable (missing store state) → cannot verify absence; treat as present so
  // the guard can never close the panel on a data-shaped surprise.
  if (!Array.isArray(st.todoList) || !Array.isArray(st.recycleList)) return false
  const inList = st.todoList.some(t => t && t.taskId === taskId) ||
                 st.recycleList.some(t => t && t.taskId === taskId)
  return !inList
}
