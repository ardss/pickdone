/** External-write watcher baseline update (extracted 2026-09-11 for unit coverage). The resync must
 *  never clobber the baseline when the mtime read fails (null) — a failed stat would otherwise make
 *  the next poll treat an unchanged DB as "externally written" and trigger a spurious full reload. */
function nextWatchBaseline (current, readMtime) {
  const m = readMtime()
  return m == null ? current : m
}

module.exports = { nextWatchBaseline }
