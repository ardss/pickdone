/**
 * [w30 P1] Attachment state unification — ONE pure mapping consumed by every attachment
 * thumbnail surface (EpAttachments.vue today; the TodoItem.vue list-row thumbnail is a
 * territory-frozen file and keeps its own logic until that ban is lifted — see the w30
 * handoff report).
 *
 * Four canonical states:
 *   'ok'      — local:// entry whose bytes are on this disk and currently load fine
 *   'syncing' — metadata row present but the bytes are not on this device yet: a non-local
 *               (LAN/remote) url, OR a local url that just errored whose one-shot pull kick
 *               (W29: open-file → attachment-missing-open → attachments-arrived) has not
 *               exhausted its retry yet
 *   'missing' — W29 migration marker (`missing: true`): the legacy host-form url could NOT
 *               be reverse-resolved to any on-disk file — unrecoverable, distinct visual
 *   'broken'  — local url whose load errored AND whose pull retry also failed (`__pullTried`
 *               set): genuinely dead key
 *
 * Pure & framework-free: entries are plain objects (the persisted list items), the load
 * argument carries the runtime <img> load verdict. The `__pullTried` flag lives on the
 * entry object (parent-owned list state) exactly as before — the W29 one-shot pull guard
 * semantics are unchanged; only the DECISION moved here so both surfaces share it.
 */

/** True when the entry's url is a local:// key (bytes are supposed to be on this disk). */
export function isLocalAttachmentUrl (url) {
  return typeof url === 'string' && url.startsWith('local://')
}

/**
 * Classify one attachment entry. `load` = { broken } — the <img> element's current
 * verdict (error fired, no successful load since). Unknown/absent entry → 'broken'
 * (defensive: never render a blind <img> for a non-object).
 */
export function attachmentStateOf (entry, load) {
  if (!entry || typeof entry !== 'object') return 'broken'
  if (entry.missing === true) return 'missing' // W29 migration marker: unrecoverable legacy key
  const url = entry.url
  if (!isLocalAttachmentUrl(url)) return 'syncing' // remote/LAN metadata row: bytes not pulled yet
  if (load && load.broken) {
    return entry.__pullTried ? 'broken' : 'syncing' // first error = pull chain still in flight
  }
  return 'ok'
}

/**
 * [W29 pull-kick decision, extracted verbatim from EpAttachments.onImgErr] Should this
 * error fire the one-shot missing-file pull chain (open-file)? Only for local:// urls
 * that have not tried yet; the flag is set on the entry by markPullTried so each url
 * kicks at most once per panel mount (no retry storm against a dead key). Returns true
 * when the caller should kick AND has marked the entry.
 */
export function shouldKickPull (entry) {
  if (!entry || typeof entry !== 'object') return false
  if (!isLocalAttachmentUrl(entry.url)) return false // non-local urls have no pull chain
  if (entry.__pullTried) return false
  entry.__pullTried = true
  return true
}
