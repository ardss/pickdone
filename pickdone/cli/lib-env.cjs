/* Environment sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Environment self-check (doctor) + App launch/summon. */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

module.exports = ({ open, CliError, userDataDir, assertIsolationForWrite }) => {
  /** Environment self-check (modeled on remctl doctor): driver/DB file/read-write/scale */
  function doctor () {
    const dir = userDataDir()
    const file = path.join(dir, 'todos.db')
    const checks = []
    // ok must stay strictly boolean: mixing true/'skipped'/'synced' made the top-level every() always truthy (string truthiness), so machine consumers could not tell;
    // 'skipped' (write probe skipped to protect real data) counts as passing, and the state field carries the raw status
    const add = (name, ok, detail) => checks.push({ check: name, ok: ok === true || ok === 'skipped', state: String(ok), detail: detail || '' })
    add('dataDir', fs.existsSync(dir), dir)
    add('dbFile', fs.existsSync(file), file)
    try {
      const db = open()
      const n = db.call('countAll')
      add('driver', true, 'better-sqlite3-multiple-ciphers (N-API prebuilt)')
      add('read', true, `${n} rows / recycle bin ${db.call('queryTodos', { deleted: 1 }).length} / categories ${db.call('getAllCategories').length}`)
      const ver = db.call('getMeta', 'todosVersion')
      add('meta', true, 'todosVersion ' + (ver != null ? 'synced' : 'local-only (db readable, no version stamp)'))
      add('write', 'skipped', 'write probe skipped to protect real data; only runs in TODO_DB_DIR isolated dir')
    } catch (e) {
      add('open', false, String(e.message || e))
    }
    return { dataDir: dir, ok: checks.every(c => c.ok), checks }
  }

  /** Launch/summon the Electron App: starts it when not running; when running, the single-instance lock brings the existing window to the front.
   *  Dev repo: spawn electron's cli.js against the project root.
   *  Packaged install: resources/cli has no node_modules — spawn the app exe at the install root instead. */
  function launchApp ({ dev = false, allowReal = false } = {}) {
    // P0: never cold-start an App instance against the real user DB — a spawned App opens
    // %APPDATA%/pickdone immediately; require explicit isolation (or --yes-i-know) first.
    assertIsolationForWrite({ allowReal })
    const root = path.join(__dirname, '..')
    const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')
    if (fs.existsSync(electronCli)) {
      const child = spawn(process.execPath, [electronCli, '.', ...(dev ? ['--dev'] : [])], {
        cwd: root, detached: true, stdio: 'ignore',
        env: { ...process.env, ELECTRON_ENABLE_LOG_DUMP: '0' }
      })
      child.unref()
      return { pid: child.pid, dev }
    }
    // Packaged layout: __dirname = <install>\resources\cli → install root is two levels up
    const installRoot = path.dirname(path.dirname(__dirname))
    const exe = fs.readdirSync(installRoot).find(f => f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(installRoot, f)).isFile())
    if (!exe) throw new CliError('app executable not found next to the install resources', 'NO_ELECTRON')
    const child = spawn(path.join(installRoot, exe), [], {
      cwd: installRoot, detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOG_DUMP: '0' }
    })
    child.unref()
    return { pid: child.pid, dev: false }
  }

  return { doctor, launchApp }
}
