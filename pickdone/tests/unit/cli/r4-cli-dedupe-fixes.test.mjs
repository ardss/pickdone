/** r4 CLI fix-round regression tests (2026-09-28) — covers:
 *  1. recordFix endTime anchor: a record with missing/corrupt endTime must FAIL LOUD (CliError)
 *     when --date/--at are not both explicit — the old `rec.endTime || Date.now()` silently
 *     anchored "today, right now" and landed a wrong dateKey (data-plane corruption via a
 *     display-plane default).
 *  2. CDP mini-client dedupe: ui-smoke.js / e2e-walkthrough.js / a11y-scan.js must require the
 *     shared cli/lib-cdp-client.cjs and carry no hand-copied ws/getJSON implementations anymore.
 *  3. Gate walker dedupe: the five gate scripts must use the shared cli/lib-filescan.cjs
 *     listFiles; the shared walker skips node_modules/dist/renderer-dist/dot-dirs, tolerates
 *     vanished entries (the old bare statSync crashed), and filters .d.ts.
 *  Isolated temp DB via TODO_DB_DIR, never touches real data (h3-agent-fixes pattern).
 *  Run: node --test tests/unit/cli/r4-cli-dedupe-fixes.test.mjs */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-r4-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const { listFiles } = require_('../../../cli/lib-filescan.cjs')
const { getJSON, sleep, killSpawnedChild, cdpConnect } = require_('../../../cli/lib-cdp-client.cjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI = path.join(ROOT, 'cli')

/* ---- fix 1: recordFix endTime anchor ---- */
test('r4-1: recordFix with only --at on a record whose endTime is missing fails loud (no Date.now() anchor)', () => {
  const rec = lib.backfillRecord({ date: '2026-01-15', at: '10:00', minutes: 25 })
  assert.equal(rec.dateKey, '2026-01-15')
  // corrupt the data plane: endTime gone (as a lost/corrupt row would look)
  commitEnd(rec.tomatoId, 0)
  assert.throws(
    () => lib.recordFix(rec.tomatoId, { at: '12:00' }),
    /no valid endTime/,
    'missing endTime + partial reposition args must refuse, not anchor to today'
  )
})

test('r4-2: recordFix with a non-positive endTime behaves the same (db layer accepts 0/negative epochs)', () => {
  const rec = lib.backfillRecord({ date: '2026-01-16', at: '10:00', minutes: 25 })
  commitEnd(rec.tomatoId, -5) // dayjs(-5) re-derives a syntactically valid dateKey, so the update lands — the data is corrupt regardless
  assert.throws(() => lib.recordFix(rec.tomatoId, { date: '2026-01-16' }), /no valid endTime/)
})

test('r4-3: explicit --date AND --at still work on a record with a corrupt endTime', () => {
  const rec = lib.backfillRecord({ date: '2026-01-17', at: '10:00', minutes: 25 })
  commitEnd(rec.tomatoId, 0)
  const { rec: fixed } = lib.recordFix(rec.tomatoId, { date: '2026-02-18', at: '08:30' })
  assert.equal(fixed.endTime != null && Number.isFinite(fixed.endTime), true)
  assert.equal(fixed.dateKey, '2026-02-18')
  assert.equal(new Date(fixed.endTime).getHours(), 8)
  assert.equal(new Date(fixed.endTime).getMinutes(), 30)
})

test('r4-4: a HEALTHY endTime still anchors a partial reposition (behavior preserved)', () => {
  const rec = lib.backfillRecord({ date: '2026-01-19', at: '10:00', minutes: 25 })
  const { rec: fixed } = lib.recordFix(rec.tomatoId, { at: '11:45' })
  assert.equal(fixed.dateKey, '2026-01-19', 'date derived from the record endTime, not today')
  assert.equal(new Date(fixed.endTime).getMinutes(), 45)
})

function commitEnd (tomatoId, v) {
  // db layer re-derives dateKey from endTime; 0/negative epochs still yield a valid YYYY-MM-DD
  // (1969/1970), so the corrupt value lands and the row is genuinely broken afterwards
  const ok = db.call('tomatoUpdateById', { tomatoId, patch: { endTime: v } })
  assert.ok(ok !== false, 'setup: corrupting endTime should succeed')
}

/* ---- fix 2: CDP client dedupe ---- */
test('r4-5: the three CDP scripts all require lib-cdp-client and define no local ws/getJSON copies', () => {
  for (const f of ['ui-smoke.js', 'e2e-walkthrough.js', 'a11y-scan.js']) {
    const src = fs.readFileSync(path.join(CLI, f), 'utf8')
    assert.ok(src.includes("require('./lib-cdp-client.cjs')"), `${f} requires the shared client`)
    assert.ok(!src.includes('new WebSocket('), `${f} must not hand-roll a CDP WebSocket`)
    assert.ok(!src.includes("http.get({ host: '127.0.0.1'"), `${f} must not hand-roll getJSON`)
    assert.ok(!src.includes('const sleep ='), `${f} must not re-define sleep`)
    assert.ok(!src.includes('taskkill'), `${f} must not re-implement the zombie kill`)
  }
})

test('r4-6: lib-cdp-client getJSON parses a JSON body (regression on the shared implementation)', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, url: req.url }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    const body = await getJSON(port, '/json/list')
    assert.equal(body.ok, true)
    assert.equal(body.url, '/json/list')
  } finally {
    await new Promise(r => server.close(r))
  }
})

test('r4-7: killSpawnedChild is a no-op with no adopted child (never throws on bare exit)', () => {
  assert.doesNotThrow(() => killSpawnedChild())
  assert.equal(typeof sleep(1).then, 'function')
  // cdpConnect signature sanity: returns the four members the scripts destructure.
  // Flake fix (2026-10-09): cdpConnect's `open` Promise rejects when the connection is
  // refused; nobody awaits it here, so if the refusal lands before close() the unhandled
  // rejection kills the whole file. Drain it explicitly (the ws 'error' event itself is
  // already handled inside lib-cdp-client.cjs via ws.onerror).
  const client = cdpConnect('ws://127.0.0.1:1/nope')
  client.open.catch(() => { /* expected: port 1 refuses */ })
  for (const k of ['ws', 'open', 'send', 'evalJS']) assert.ok(client[k] != null, 'client has ' + k)
  client.ws.close?.()
})

/* ---- fix 3: gate walker dedupe ---- */
test('r4-8: the five gate scripts use the shared lib-filescan listFiles', () => {
  for (const f of ['check-file-size.cjs', 'check-boot-order.cjs', 'check-dualwrite.cjs', 'check-esm-graph.cjs', 'check-command-bus.cjs']) {
    const src = fs.readFileSync(path.join(CLI, f), 'utf8')
    assert.ok(src.includes("require('./lib-filescan.cjs')"), `${f} requires the shared walker`)
    assert.ok(!src.includes('fs.statSync(p).isDirectory()'), `${f} must not hand-roll a statSync walker`)
  }
})

test('r4-9: shared listFiles skips node_modules/dist/renderer-dist/dot-dirs, filters .d.ts, includes js/vue/cjs/mjs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-filescan-'))
  try {
    for (const d of ['node_modules/pkg', 'dist', 'renderer-dist', '.git', 'src/deep', 'keep']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true })
    }
    const mk = p => fs.writeFileSync(path.join(tmp, p), 'x')
    mk('node_modules/pkg/a.js'); mk('dist/b.js'); mk('renderer-dist/c.js'); mk('.git/d.js')
    mk('src/deep/code.js'); mk('src/deep/code.cjs'); mk('src/deep/code.mjs'); mk('src/deep/comp.vue')
    mk('src/deep/types.d.ts'); mk('src/deep/readme.txt'); mk('keep/top.js')
    const rel = listFiles(tmp).map(f => path.relative(tmp, f).replace(/\\/g, '/')).sort()
    assert.deepEqual(rel, ['keep/top.js', 'src/deep/code.cjs', 'src/deep/code.js', 'src/deep/code.mjs', 'src/deep/comp.vue'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('r4-10: shared listFiles survives a vanished directory and a vanished file (old statSync crash)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-filescan-vanish-'))
  try {
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'sub', 'x.js'), 'x')
    fs.writeFileSync(path.join(tmp, 'y.js'), 'x')
    const res = listFiles(tmp)
    assert.equal(res.length, 2)
    // entry vanishing between readdir and stat: the walker must skip, not throw
    const ghost = { isDirectory: () => true, name: 'gone' }
    const orig = fs.readdirSync
    try {
      fs.readdirSync = (d, o) => (d === tmp ? [ghost] : orig(d, o))
      let res2 = []
      assert.doesNotThrow(() => { res2 = listFiles(tmp) })
      assert.deepEqual(res2, [], 'the vanished subdirectory is skipped silently')
    } finally {
      fs.readdirSync = orig
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
