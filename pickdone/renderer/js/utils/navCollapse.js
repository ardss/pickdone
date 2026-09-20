/** U4 (2026-09-20, pure, unit-tested): narrow-viewport forced sidebar collapse state machine.
 *
 *  Contract: the synced `sidebarCollapsed` preference changes ONLY via an explicit user toggle.
 *  Viewport events drive the TRANSIENT `forcedCollapsed` field exclusively — a narrow window must
 *  never write the settings store (the old code flipped the userCollapsed setter on viewport
 *  events, persisting + syncing a preference the user never chose). `state` is the component
 *  instance (uses its `narrow` / `forcedCollapsed` fields); `settings` is anything with a
 *  `sidebarCollapsed` value read — it is only ever READ here, never written. */

/** Apply a matchMedia change/mount snapshot: collapse while narrow, restore when widened. */
export function applyNarrow (state, matches) {
  const was = !!state.narrow
  state.narrow = !!matches
  state.forcedCollapsed = !!matches
  return was !== !!matches // true exactly when the viewport crossed the breakpoint
}

/** Explicit user toggle: resolves against the EFFECTIVE collapsed state (preference OR forced), so
 *  a user can expand inside a narrow window too. `getCollapsed()` = effective collapsed read;
 *  `commit(v)` is the ONLY place the synced preference is written. Returns the new preference. */
export function toggleCollapse ({ getCollapsed, commit }) {
  const next = !getCollapsed()
  commit(next)
  return next
}
