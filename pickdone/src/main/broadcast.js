/* Broadcast helpers (moved verbatim out of index.js 2026-10-30): fan a DB-change reason out to
   every live window. Pure dependency injection — the only electron object needed is
   BrowserWindow.getAllWindows(). index.js constructs the factory once at module top (after the
   electron require, before any consumer) and injects the same three functions into extWatch,
   the dbm ledger hook and the IPC handler context exactly as before. */
function createBroadcasts ({ BrowserWindow }) {
  function broadcastTomatoRecordsChanged (reason, excludeWebContents) {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed()) continue
        if (excludeWebContents && w.webContents === excludeWebContents) continue
        w.webContents.send('tomato-records-changed', { reason, at: Date.now() })
      } catch {}
    }
  }
  function broadcastTodosChanged (reason, excludeWebContents) {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed()) continue
        if (excludeWebContents && w.webContents === excludeWebContents) continue
        w.webContents.send('todos-changed', { reason, at: Date.now() })
      } catch {}
    }
  }
  function broadcastWhiteNoiseUpdated () {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (w && !w.isDestroyed()) w.webContents.send('white-noise-updated') } catch {}
    }
  }
  return { broadcastTomatoRecordsChanged, broadcastTodosChanged, broadcastWhiteNoiseUpdated }
}

module.exports = { createBroadcasts }
