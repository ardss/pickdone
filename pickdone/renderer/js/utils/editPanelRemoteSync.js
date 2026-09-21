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
const FINGERPRINT_FIELDS = [
  ['title', 'taskContent'],
  ['desc', 'taskDescribe'],
  ['dateTs', 'todoTime'],
  ['remindTs', 'reminderTime'],
  ['priority', 'priority'],
  ['important', 'important'],
  ['categoryId', 'categoryId']
]

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
