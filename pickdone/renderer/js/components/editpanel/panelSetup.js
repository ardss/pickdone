/**
 * W21 split (2026-10-30): mounted-time panel setup mechanics pulled out of EditPanel.vue
 * (spellcheck suppression + spotlight tour). The Esc handler, flush hook and all save wiring
 * stay in the host. Pure `vm`-taking functions (same convention as edit-panel/repeat.js).
 */

// Disable the browser's native spell check (English correction squiggles interfere with typing over Chinese content)
export function disableSpellcheck (vm) {
  vm.$nextTick(() => {
    vm.$el.querySelectorAll('textarea, input').forEach(el => el.setAttribute('spellcheck', 'false'))
  })
}

// Dynamically created inputs (subtasks etc.) also get spell check disabled; named handler removed
// in beforeUnmount (listener accumulation when nodes are replaced after hydrate).
export function dynamicSpellcheckGuard () {
  return e => {
    const t = e.target
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.hasAttribute('spellcheck')) t.setAttribute('spellcheck', 'false')
  }
}

// First open of the edit panel: spotlight tour for the attachment toolbar (in-context teaching)
export function runEditpanelTour () {
  import('../../utils/onboardingTours.js').then(mod => mod.maybeRunTour('editpanel', 600)).catch(() => {})
}
