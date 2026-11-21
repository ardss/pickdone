/** Float auto-show (W23) — extracted from main.js so the boot entry stops growing and the chain
 *  can be exercised as behaviour instead of source-text regexes.
 *
 *  Contract: every aux window loads main.js too, so registration is a no-op outside the main
 *  shell (auto-showing there would "revive" a float the user just closed). Inside the main shell
 *  it arms one timer; when it fires:
 *    - no API / setting off  -> nothing, but the reason is logged
 *    - user closed it last run (marker '1') -> stay closed, explicit intent wins
 *    - marker read fails     -> SHOW. A rejected getMeta (DB still opening) used to be swallowed
 *      as "keep it closed", which turned an enabled widget into an absent one until restart.
 */
export const FLOAT_AUTO_SHOW_DELAY_MS = 6000
export const FLOAT_CLOSED_MARKER_KEY = 'tomatoFloatClosedByUser'

export function registerFloatAutoShow ({
  isMainShell,
  store,
  api = () => (typeof window === 'undefined' ? null : window.todoAPI),
  timer = setTimeout,
  log = console,
  delayMs = FLOAT_AUTO_SHOW_DELAY_MS
} = {}) {
  try {
    if (!isMainShell) return
    timer(() => {
      const todoAPI = api()
      if (!todoAPI) return
      if (store.state.settings.enableTomatoFloating === false) {
        // W23 (P2): legitimate skip, but never silent — the value also reveals stale config.json residue
        log.info('[float-auto-show] skipped: enableTomatoFloating ===', store.state.settings.enableTomatoFloating, '(switch off, or stale config.json residue)')
        return
      }
      const showIfEnabled = () => {
        if (store.state.settings.enableTomatoFloating === false) return
        Promise.resolve(todoAPI.showTomatoFloat()).catch(e => log.warn('[float-auto-show] invoke rejected:', e))
      }
      // The read is IPC: it can reject asynchronously AND (on a broken bridge) throw synchronously.
      // Normalising both into one promise means there is exactly one failure path to reason about.
      Promise.resolve()
        .then(() => todoAPI.dbCall('getMeta', FLOAT_CLOSED_MARKER_KEY))
        .then(v => {
          if (v === '1') return // explicit user close intent must still win
          showIfEnabled()
        })
        .catch(e => {
          log.warn('[float-auto-show] closed-marker read failed; opening enabled float:', e)
          showIfEnabled()
        })
    }, delayMs)
  } catch (e) {
    log.error('[float-auto-show] registration failed:', (e && e.stack) || e) // W23: failure-proof + loud
  }
}
