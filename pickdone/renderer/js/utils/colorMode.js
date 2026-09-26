/**
 * Color-mode resolution/application - extracted pure helper so the boot path is node-testable.
 * Consumers (main.js) apply it pre-mount (persisted colorMode is already in store state:
 * settings.js `state: load()` merges localStorage synchronously at module evaluation) and
 * re-apply on OS scheme change (matchMedia listener) and settings/updateSettings mutations.
 * Idempotent: setAttribute + classList.toggle only, safe to call any number of times.
 */

/** 'light' | 'dark' | 'system' (+ mqlMatches) -> { dark, theme } */
export function resolveColorMode (mode, mqlMatches) {
  const dark = mode === 'system' ? !!mqlMatches : mode === 'dark'
  return { dark, theme: dark ? 'dark' : 'light' }
}

/** Applies data-theme + .dark on doc.documentElement; returns the applied theme name */
export function applyColorMode (mode, mqlMatches, doc) {
  const { dark, theme } = resolveColorMode(mode, mqlMatches)
  doc.documentElement.setAttribute('data-theme', theme)
  doc.documentElement.classList.toggle('dark', dark)
  return theme
}
