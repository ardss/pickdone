/* Command-channel sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Tomato + LAN-sync command channels: CLI writes a meta command → the running App dispatches → writes state back. */
module.exports = ({ open, commit, audit }) => {
  /* ---------------- Pomodoro command channel (CLI writes a meta command → the running App dispatches the existing tomato action → writes state back)
     State machine/idempotency/ledger all live in the App renderer's store/tomato.js; the CLI never writes pomodoro state in parallel. When the App is not running, status is marked pending. */
  function writeTomatoCmd (cmd) {
    // Monotonically increasing sequence: the App drops stale commands via cmd.seq > lastTomatoSeq; two commands fired in the same millisecond via Date.now() would silently lose the second one
    // (common in scripted AI scenarios), so a persisted counter in meta is read-modify-written instead
    // Atomic increment (+1 inside SQL): two concurrent CLI processes writing the same seq would make the App's seq dedup silently drop the second command (audit H4)
    const seq = open().call('nextCliTomatoSeq')
    commit('meta', 'put', ['cliTomatoCmd', JSON.stringify({ seq, at: Date.now(), ...cmd })])
    audit.record({ action: 'tomato.' + cmd.action, targets: cmd.taskId ? [{ taskId: cmd.taskId }] : [], changes: [], note: 'CLI tomato command (App executes and writes back cliTomatoState)' })
    return seq
  }
  function readTomatoState () {
    const raw = open().call('getMeta', 'cliTomatoState')
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  /* Wait for the App's consumption receipt: cliTomatoState.seq catching up means executed. Returns null on timeout (App not running / locked).
     The HELP contract promises start errors when the App is not running — writing meta and reporting success once made scripts believe focus had begun */
  async function waitForTomatoAck (seq, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const st = readTomatoState()
      // EXACT match (same contract as waitForSyncAck below): cliTomatoState is a SINGLE slot — a
      // second command overwrites the first's receipt, and `>=` let a later command's higher seq
      // satisfy the earlier waiter, reporting "✓ focus started" for a command the App never ran.
      if (st && st.seq === seq) return st
      await new Promise(r => setTimeout(r, 200))
    }
    return null
  }
  /** Live remaining seconds for status: remainSec is frozen at the last command time; during focus it is derived from startedAt; state not written back for over 5s is marked stale */
  function tomatoLiveRemainSec (st) {
    if (!st) return 0
    if (st.status === 'startTomatoTime' && st.startedAt) {
      return Math.max(0, Math.round(st.tomatoTime * 60 - (Date.now() - st.startedAt) / 1000))
    }
    if (st.status === 'startRestTime' && st.startedAt) {
      return Math.max(0, Math.round((st.remainSec || 0) - (Date.now() - st.at) / 1000))
    }
    return st.remainSec || 0
  }

  /* ---------------- LAN sync command channel (feat/cli-sync-pair): same contract as the tomato channel —
     CLI writes meta cliSyncCmd (seq via atomic nextCliSyncSeq) → the running App's main process
     dispatches into db-sync-ops (the Device Center's own registry) → writes the receipt to
     cliSyncState. The receipt wait matches the seq EXACTLY (not >=): a long-running pair must not
     have its waiter satisfied by a later status command's higher seq landing first. */
  function writeSyncCmd (cmd) {
    const seq = open().call('nextCliSyncSeq')
    commit('meta', 'put', ['cliSyncCmd', JSON.stringify({ seq, at: Date.now(), ...cmd })])
    audit.record({ action: 'sync.' + cmd.action, targets: [], changes: [], note: 'CLI sync command (App executes and writes back cliSyncState)' })
    return seq
  }
  function readSyncState () {
    const raw = open().call('getMeta', 'cliSyncState')
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  async function waitForSyncAck (seq, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const st = readSyncState()
      if (st && st.seq === seq) return st
      await new Promise(r => setTimeout(r, 200))
    }
    return null
  }

  return { writeTomatoCmd, readTomatoState, waitForTomatoAck, tomatoLiveRemainSec, writeSyncCmd, readSyncState, waitForSyncAck }
}
