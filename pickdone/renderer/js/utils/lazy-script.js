/**
 * Lazy loader for heavy vendor libraries (2026-09-02 startup optimization) — index.html no longer loads them synchronously:
 * chart/html2canvas/fullcalendar (jspdf, a zero-reference fossil, was removed); injected on demand at first use.
 * The same src is injected only once globally (Promise cache; concurrent calls share one load).
 * Failures aren't cached: the next call retries (self-healing from offline / app:// jitter).
 */
const cache = new Map()

// Resource prefix adapts to the host: Electron = app://app/, 5175 web debug host = http same-origin relative path
const BASE = location.protocol.startsWith('http') ? '' : 'app://app'

export function loadScript (src) {
  let p = cache.get(src)
  if (p && !p.__failed) return p
  p = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => {
      cache.delete(src)
      p.__failed = true
      s.remove()
      reject(new Error('[lazy-script] failed to load: ' + src))
    }
    document.head.appendChild(s)
  })
  cache.set(src, p)
  return p
}

/** Full vendor-lib list, same source as index.html (app:// prefix) */
export const VENDOR = {
  chart: BASE + '/assets/vendor-lib/chart.umd.js',
  html2canvas: BASE + '/assets/vendor-lib/html2canvas.min.js',
  fcCore: BASE + '/assets/vendor-lib/fullcalendar/core.index.global.min.js',
  fcLocales: BASE + '/assets/vendor-lib/fullcalendar/core.locales-all.global.min.js',
  fcDayGrid: BASE + '/assets/vendor-lib/fullcalendar/daygrid.index.global.min.js',
  fcInteraction: BASE + '/assets/vendor-lib/fullcalendar/interaction.index.global.min.js'
}

/** FullCalendar bundle loaded in dependency order (core → locales/daygrid/interaction attach onto core) */
export function ensureFullCalendar () {
  return loadScript(VENDOR.fcCore)
    .then(() => Promise.all([
      loadScript(VENDOR.fcLocales),
      loadScript(VENDOR.fcDayGrid),
      loadScript(VENDOR.fcInteraction)
    ]))
    .then(() => window.FullCalendar)
}
