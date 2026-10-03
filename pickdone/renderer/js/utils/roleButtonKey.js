/**
 * [D15-A13] ARIA button-pattern keyboard activation.
 *
 * role="button" widgets across the app (WeatherWidget, SnFootActions, CompletedView tip,
 * TagAllView chips, ...) used to bind only @keydown.enter. The ARIA button pattern requires
 * BOTH Enter and Space to activate — Space is the primary activation key for screen-reader and
 * keyboard users, and on a non-interactive element the default scroll must be suppressed too.
 * One shared handler instead of N divergent inline bindings.
 */
export function roleButtonActivate (handler, { stop = false } = {}) {
  return function onKey (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (stop) e.stopPropagation()
    handler.call(this, e)
  }
}

/**
 * [A8] ARIA checkbox-pattern keyboard activation.
 *
 * Hand-rolled role="checkbox" spans (td-check, td-sub, habit check, matrix/deck/recycle
 * checkboxes, ...) used to bind only @keydown.enter. The ARIA checkbox pattern requires
 * BOTH Enter and Space to toggle — Space is the primary activation key for screen-reader
 * and keyboard users. preventDefault suppresses the page scroll a Space would otherwise
 * trigger on a non-interactive element; stopPropagation keeps the toggle from also firing
 * the parent row's Enter/Space activation (the checkboxes all sit inside clickable rows,
 * matching the .enter.prevent.stop bindings each site used before).
 */
export function roleCheckboxActivate (handler) {
  return function onKey (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    handler.call(this, e)
  }
}

/**
 * [A2/A6] ARIA radiogroup pattern (roving tabindex) for hand-rolled role="radio" pills.
 *
 * The container is the single Tab stop (the caller binds :tabindex="checked ? 0 : -1" per
 * radio); inside the group:
 *   - Space/Enter select the focused radio
 *   - ArrowDown/ArrowRight move to (and select) the next radio, ArrowUp/ArrowLeft the
 *     previous one, wrapping at both ends — arrows are the group's navigation AND
 *     selection gesture, so one Tab stop makes the whole group fully operable.
 * `select` receives the radio ELEMENT that should become selected (the focused one for
 * Space/Enter, the neighbor for arrows); the caller maps element -> value, e.g. via a
 * data-* attribute, and also updates whatever state drives the roving tabindex.
 */
export function roleRadioActivate (select) {
  return function onKey (e) {
    const el = e.currentTarget
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select.call(this, el, e)
      return
    }
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const group = el.closest('[role="radiogroup"]')
    if (!group) return
    const radios = Array.from(group.querySelectorAll('[role="radio"]'))
    if (!radios.length) return
    const next = radios[(radios.indexOf(el) + dir + radios.length) % radios.length]
    if (!next) return
    next.focus()
    select.call(this, next, e)
  }
}
