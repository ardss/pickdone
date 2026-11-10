// Hash router — Web deep links share the SAME task ids as desktop/Android.
// Supported: '' | '#' | '#/' -> today; '#/<tab>'; '#/task/<id>' -> a concrete task.
// Unknown routes fall back to today so a stale link never blanks the app.

const TABS = ['today', 'projects', 'history', 'sync', 'backup']

export function parseHash(hash) {
  const raw = String(hash || '')
  const path = raw.startsWith('#') ? raw.slice(1) : raw
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'task' && parts[1]) return { name: 'task', id: parts[1] }
  if (parts.length === 1 && TABS.includes(parts[0])) return { name: parts[0] }
  return { name: 'today' }
}

export function hashFor(route) {
  if (route?.name === 'task' && route.id) return '#/task/' + String(route.id)
  if (TABS.includes(route?.name)) return '#/' + route.name
  return '#/today'
}
