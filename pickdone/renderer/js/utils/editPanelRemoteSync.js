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
 *  shown instead — user input is never auto-overwritten. */

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

export const PANEL_FIELD_KEYS = PANEL_FIELD_MAP.map(([k]) => k)

const FINGERPRINT_FIELDS = [
  ['title', 'taskContent'],
  ['desc', 'taskDescribe'],
  ['dateTs', 'todoTime'],
  ['remindTs', 'reminderTime'],
  ['priority', 'priority'],
  ['important', 'important'],
  ['categoryId', 'categoryId']
]

/** Panel-snapshot keys the own-save-echo fingerprint depends on. Exported for the shape
 *  consistency test: every one of these MUST be present in the openEdit snapshot. */
export const FINGERPRINT_PANEL_KEYS = FINGERPRINT_FIELDS.map(([k]) => k)

/** Fingerprint of the core editable fields (order-stable, tolerant of missing rows; accepts both
 *  the panel snapshot shape and the raw store row). */
export function contentFingerprint (t) {
  if (!t || typeof t !== 'object') return ''
  const parts = []
  for (const [panelKey, rowKey] of FINGERPRINT_FIELDS) {
    const v = t[panelKey] !== undefined ? t[panelKey] : t[rowKey]
    parts.push(`${panelKey}=${v === undefined || v === null ? '' : String(v)}`)
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
