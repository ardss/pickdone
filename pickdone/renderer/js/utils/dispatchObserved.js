/**
 * [maint/d23 FIX-3b] Observed store dispatches for the pomodoro UI.
 *
 * Fire-and-forget dispatch(...) calls swallow rejections: when an action rejects
 * (IPC down, persistence failure) the UI silently keeps running — e.g. a rest
 * countdown kept ticking after a failed abandon, and a failed startFocus left the
 * bar idle with no explanation. Every tomato startFocus/giveUp dispatch goes through
 * this helper instead: it awaits the action, logs the failure once at the source,
 * and re-throws so the component's .catch can surface the shared actionFailedMsg
 * toast (same shape as the D22 TomatoAbandonModal / TomatoFloatPage.confirmAbandon fix).
 */
export function observeDispatch (store, action, payload) {
  return Promise.resolve()
    .then(() => store.dispatch(action, payload))
    .catch(e => {
      console.error('[tomato] ' + action + ' failed:', e)
      throw e
    })
}
