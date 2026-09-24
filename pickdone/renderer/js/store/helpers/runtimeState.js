/** Runtime state (not user settings): volatile counters/timestamps that persist across restarts but semantically aren't "settings"
 *  Stored in localStorage 'runtimeState', kept separate from settingsState to avoid polluting settings and backup dedupe */
const KEY = 'runtimeState'

export function loadRuntime () {
  try { return { ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return {} }
}

export function saveRuntime (patch) {
  const next = { ...loadRuntime(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
  return next
}
