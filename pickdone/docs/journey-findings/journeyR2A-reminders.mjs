/* Round-2 Journey R2A: reminder scheduler matrix, live.
   Seeds via the real CLI, boots with stdout captured, asserts '[Reminder] fired:' lines:
   A(+3m) B(+5m) C(+7m, deleted at +6m → must NOT fire) D(+8m→edited at +4m to +11m)
   F(+9m with -1min offset → fires +8m and +9m) — then crash() (quit chain skipped) and reboot:
   already-fired must NOT re-fire (dedup durability), past-due task E seeded while closed must
   catch-up fire at boot ("missed re-fired").

   HARNESS CONTRACT (learned the hard way, first run split-brained): the APP takes its data dir
   from TODO_USER_DATA_DIR only (index.js:53 app.setPath), while the CLI resolves user-dir.js with
   TODO_DB_DIR FIRST and TODO_DB_DIR points DIRECTLY at the directory containing todos.db. So the
   CLI must be invoked with TODO_DB_DIR = <the same dir the app uses as userData> — pointing it at
   <userData>/db (what bootJourney's dbDir returns) silently writes a DIFFERENT database. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const ROOT = join(OUT, '..', '..')
const DIR = join(OUT, 'rem5-dir') // v4: FRESH path every rerun — v3 was poisoned by a corpse-removal rm that hit this exact reused path while the run lived
const LOG = join(OUT, 'rem5-stdout.log')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 600)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// TODO_DB_DIR points DIRECTLY at the dir containing todos.db = the app's userData root (user-dir.js)
const cliEnv = { ...process.env, TODO_DB_DIR: DIR }
const cli = args => execSync(`node cli/pickdone.js ${args}`, { encoding: 'utf8', timeout: 30000, env: cliEnv, cwd: ROOT })
const ts = d => {
  const x = new Date(d)
  const p = n => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`
}
const readLog = () => { try { return existsSync(LOG) ? readFileSync(LOG, 'utf8') : '' } catch { return '' } }
const firedLines = fromIdx => readLog().split('\n').filter(l => l.includes('[Reminder] fired:')).slice(fromIdx || 0)
const idOf = name => {
  try {
    const out = execSync(`node cli/pickdone.js search ${name}`, { encoding: 'utf8', timeout: 20000, env: cliEnv, cwd: ROOT })
    const m = out.match(/([0-9a-f]{10,})/i)
    return m ? m[1] : null
  } catch { return null }
}
const waitFired = async (id, timeoutMs) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = readLog().split('\n').find(l => l.includes('[Reminder] fired:') && id && l.includes(id))
    if (hit) return hit.trim()
    await sleep(1500)
  }
  return 'MISS'
}

rmSync(DIR, { recursive: true, force: true })
rmSync(LOG, { force: true })
mkdirSync(join(DIR, 'db'), { recursive: true })

// ---- pre-boot CLI seeding (app closed, isolation via env) ----
const T0 = Date.now()
const at = m => ts(T0 + m * 60000)
const seedOut = {}
for (const [name, m] of [['remA', 3], ['remB', 5], ['remC', 7], ['remD', 8], ['remF', 9]]) {
  try { seedOut[name] = cli(`add "${name}" --date "${at(m)}" --reminder "${at(m)}"`); say('seed-' + name, seedOut[name].replace(/\s+/g, ' ').slice(0, 120)) }
  catch (e) { say('seed-' + name + '-FAILED', String(e).slice(0, 300)) }
}
try { say('offset-F', cli(`edit "remF" --remind-offset "-1"`).replace(/\s+/g, ' ').slice(0, 120)) }
catch (e) { say('offset-F-FAILED', String(e).slice(0, 250)) }
const ids = {}
for (const n of ['remA', 'remB', 'remC', 'remD', 'remF']) {
  const m = (seedOut[n] || '').match(/tid_[A-Za-z0-9]+_\d+/)
  ids[n] = m ? m[0] : null
}
say('ids', ids)

const j = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
// outside-kill sentinel: record any uncommanded death with an exact window (round-2A v3)
const heart = []
const hb = setInterval(() => {
  heart.push({ t: new Date().toLocaleTimeString('en-GB'), alive: j.child.exitCode === null })
  if (j.child.exitCode !== null) { say('UNCOMMANDED-DEATH', { at: new Date().toLocaleTimeString('en-GB'), exitCode: j.child.exitCode, lastAlive: heart.filter(h => h.alive).slice(-1)[0] }); clearInterval(hb) }
}, 2000)
try {
  await sleep(12000)
  say('boot-rebuild-line', (readLog().split('\n').find(l => l.includes('scheduler rebuild done')) || 'NO-REBUILD-LINE').trim())
  say('fired-count-at-boot', firedLines().length)

  const firedA = await waitFired(ids.remA, Math.max(1000, (T0 + 3 * 60000 + 45000) - Date.now()))
  say('firedA', firedA)
  await sleep(Math.max(0, (T0 + 4 * 60000) - Date.now()))
  say('edit-D', cli(`edit "remD" --reminder "${at(11)}"`).replace(/\s+/g, ' ').slice(0, 150))
  const firedB = await waitFired(ids.remB, Math.max(1000, (T0 + 5 * 60000 + 45000) - Date.now()))
  say('firedB', firedB)
  await sleep(Math.max(0, (T0 + 6 * 60000) - Date.now()))
  say('delete-C', cli(`delete "remC"`).replace(/\s+/g, ' ').slice(0, 150))
  await sleep(Math.max(0, (T0 + 7 * 60000 + 45000) - Date.now()))
  say('firedC-count(expect0)', firedLines().filter(l => ids.remC && l.includes(ids.remC)).length)
  const firedFearly = await waitFired(ids.remF + ' -60', Math.max(1000, (T0 + 8 * 60000 + 45000) - Date.now()))
  say('firedF-early(-60)', firedFearly)
  const firedFmain = await waitFired(ids.remF + ' 0', Math.max(1000, (T0 + 9 * 60000 + 45000) - Date.now()))
  say('firedF-main', firedFmain)
  say('firedD-count-by-9.5m(expect0)', firedLines().filter(l => ids.remD && l.includes(ids.remD)).length)

  await sleep(Math.max(0, (T0 + 10 * 60000) - Date.now()))
  say('pre-crash-fired-lines', firedLines().map(l => l.trim()))
  clearInterval(hb)
  j.crash()
  await sleep(3000)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
}
try { await j.end({ preserveDir: true }) } catch { /* already dead */ }

// ---- boot 2: past-due catch-up + dedup durability (crash skipped the quit flush) ----
try {
  try { say('seed-E-past', cli(`add "remE" --date "${ts(Date.now() - 60000)}" --reminder "${ts(Date.now() - 60000)}"`).replace(/\s+/g, ' ').slice(0, 150)) }
  catch (e) { say('seed-E-FAILED', String(e).slice(0, 250)) }
  const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
  try {
    await sleep(15000)
    const log2 = readLog()
    const boot2Start = log2.lastIndexOf('---- boot ')
    const tail = log2.slice(boot2Start)
    say('boot2-rebuild-line', (tail.split('\n').find(l => l.includes('scheduler rebuild done')) || 'NO-REBUILD-LINE').trim())
    say('boot2-fired-lines', tail.split('\n').filter(l => l.includes('[Reminder] fired:')).map(l => l.trim()))
    say('boot2-refire-check', {
      A: tail.split('\n').filter(l => l.includes('[Reminder] fired:') && ids.remA && l.includes(ids.remA)).length,
      B: tail.split('\n').filter(l => l.includes('[Reminder] fired:') && ids.remB && l.includes(ids.remB)).length,
      F: tail.split('\n').filter(l => l.includes('[Reminder] fired:') && ids.remF && l.includes(ids.remF)).length,
    })
  } finally {
    await j2.end({ preserveDir: false })
  }
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 1500))
}
writeFileSync(join(OUT, 'journeyR2A-log.json'), JSON.stringify(log), 'utf8')
console.log('JOURNEY-R2A DONE')
