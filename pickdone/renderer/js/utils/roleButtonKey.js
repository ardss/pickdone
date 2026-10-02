/**
 * [D15-A13] ARIA button-pattern keyboard activation.
 *
 * role="button" widgets across the app (WeatherWidget, SnFootActions, CompletedView tip,
 * TagAllView chips, ...) used to bind only @keydown.enter. The ARIA button pattern requires
 * BOTH Enter and Space to activate — Space is the primary activation key for screen-reader and
 * keyboard users, and on a non-interactive element the default scroll must be suppressed too.
 * One shared handler instead of N divergent inline bindings.
 */
export function roleButtonActivate (handler) {
  return function onKey (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    handler.call(this, e)
  }
}
