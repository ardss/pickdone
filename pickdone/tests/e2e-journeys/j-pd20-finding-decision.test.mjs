/**
 * pd20 S1 closure journey — j-pd20-finding-decision.test.mjs
 * J1 (mission §09) Finding/Decision leg, driven through the REAL CLI doors on a REAL isolated
 * SQLite library (TODO_DB_DIR) — the same-source interface an external agent actually uses
 * (cli/pickdone.js work ...), no mocks, no second database:
 *
 *   Leg 1  desktop: `add` creates the task row in the isolated library (the same todos table
 *          the desktop App reads — a real persisted task, not a fixture object).
 *   Leg 2  Agent A: work add-episode (role=agent) → work add-source (provenance) →
 *          work add-finding (observed fact, confidence high, level observed, --by agent:A).
 *          The never-fabricate guard is exercised for real: a speculation + confirmed
 *          combination is REJECTED at the CLI door (exit 1), and an out-of-family
 *          confidence is rejected too.
 *   Leg 3  Agent B: work list-finding reads the observed fact → work add-decision records
 *          the choice (alternatives/tradeoffs/decider/rationale/relatedFindings) AND a
 *          second decision that SUPERSEDES the first (revocable relation) → work handoff
 *          --out writes the export pair; handoff.json carries findings + decisions and the
 *          markdown carries the Findings:/Decisions: sections.
 *   Leg 4  Human QA restart: every CLI invocation is a fresh process opening the library
 *          from disk — the restart leg re-opens and asserts the FULL context comes back
 *          (task + episodes + sources + findings + decisions, supersedes/supersededBy
 *          intact) with zero re-statement and zero loss; a second full read is byte-stable
 *          (migration/idempotent open, no drift).
 *
 * Run: cd pickdone && node --test tests/e2e-journeys/j-pd20-finding-decision.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..')
const CLI = path.join(APP_ROOT, 'cli', 'pickdone.js')

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd20-j1-fd-'))
const handoffDir = path.join(dbDir, 'handoff-export')

const cli = (args, { expectFail = false } = {}) => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: APP_ROOT,
      env: { ...process.env, TODO_DB_DIR: dbDir },
      encoding: 'utf8',
      timeout: 120000
    })
    assert.ok(!expectFail, 'expected the CLI to fail: ' + args.join(' '))
    return out
  } catch (e) {
    if (expectFail) return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
    throw e
  }
}
const jsonOut = args => JSON.parse(cli([...args, '--json'])).data

test('J1 Finding/Decision journey: desktop task → Agent A facts → Agent B decisions + handoff → QA restart recovery', () => {
  // ---- Leg 1: the desktop door creates a real task row ----
  const task = jsonOut(['add', 'J1 finding/decision journey task'])
  assert.ok(task && task.taskId, 'the add command minted a real taskId')
  const taskId = task.taskId

  // ---- Leg 2: Agent A records the work round, the provenance, the observed fact ----
  const ep = jsonOut(['work', taskId, 'add-episode', '--goal', 'Investigate the sync failure', '--outcome', 'Port 58490 refused connections', '--role', 'agent'])
  assert.ok(ep.episodeId, 'Agent A episode persisted')
  const src = jsonOut(['work', taskId, 'add-source', '--uri', 'https://example.invalid/sync-spec', '--title', 'Sync spec'])
  assert.ok(src.sourceRefId, 'Agent A provenance ref persisted')
  const fnd = jsonOut(['work', taskId, 'add-finding', '--statement', 'Port 58490 is blocked by the firewall on device B', '--confidence', 'high', '--level', 'observed', '--by', 'agent:A'])
  assert.ok(fnd.findingId && fnd.findingId.startsWith('fnd_'), 'Agent A finding persisted with an fnd_ id')
  assert.equal(fnd.verificationLevel, 'observed')

  // The never-fabricate guard, exercised live: a guess cannot be confirmed through the door.
  const spec = cli(['work', taskId, 'add-finding', '--statement', 'I guess the token expired', '--level', 'speculation', '--status', 'confirmed'], { expectFail: true })
  assert.equal(spec.code, 1, 'speculation+confirmed is rejected (exit 1)')
  assert.match(spec.out, /speculation cannot be confirmed/, 'the rejection names the mission rule')
  // An out-of-family confidence is rejected too (the storage would store NULL; the CLI errors instead).
  const badConf = cli(['work', taskId, 'add-finding', '--statement', 'x', '--confidence', 'certain'], { expectFail: true })
  assert.equal(badConf.code, 1)
  assert.match(badConf.out, /--confidence must be one of/, 'out-of-family confidence is an explicit USAGE error')

  // ---- Leg 3: Agent B reads the facts (no re-statement) and decides ----
  const findings = jsonOut(['work', taskId, 'list-finding'])
  assert.equal(findings.length, 1, 'Agent B sees exactly the finding Agent A recorded')
  assert.equal(findings[0].statement, 'Port 58490 is blocked by the firewall on device B')
  assert.equal(findings[0].createdBy, 'agent:A')
  const dec1 = jsonOut(['work', taskId, 'add-decision', '--choice', 'Switch the mobile transport to native HTTP', '--alternatives', 'keep the bridge|drop mobile sync', '--tradeoffs', 'more work now|safe on real devices', '--decider', 'agent:B', '--rationale', 'WebView HTTPS cannot call the HTTP bridge (mixed content)', '--findings', findings[0].findingId])
  assert.ok(dec1.decisionId.startsWith('dec_'), 'Agent B decision persisted')
  const dec2 = jsonOut(['work', taskId, 'add-decision', '--choice', 'Ship native HTTP behind a feature flag first', '--decider', 'agent:B', '--supersedes', dec1.decisionId, '--rationale', 'flagged rollout lowers the rollback risk'])
  assert.ok(dec2.decisionId, 'the superseding decision persisted')

  const decisions = jsonOut(['work', taskId, 'list-decision'])
  assert.equal(decisions.length, 2)
  const d1 = decisions.find(d => d.decisionId === dec1.decisionId)
  const d2 = decisions.find(d => d.decisionId === dec2.decisionId)
  assert.deepEqual(d1.supersededBy, [dec2.decisionId], 'the reverse relation points back at the revoking decision')
  assert.equal(d2.supersedes, dec1.decisionId)

  // The handoff export carries the findings and the decisions (md + json pair).
  cli(['work', taskId, 'handoff', '--out', handoffDir])
  const handoffJson = JSON.parse(fs.readFileSync(path.join(handoffDir, 'handoff.json'), 'utf8'))
  assert.equal(handoffJson.findings.length, 1, 'handoff.json carries the finding')
  assert.equal(handoffJson.findings[0].findingId, fnd.findingId)
  assert.equal(handoffJson.decisions.length, 2, 'handoff.json carries both decisions')
  assert.equal(handoffJson.decisions[0].choice, 'Switch the mobile transport to native HTTP')
  const handoffMd = fs.readFileSync(path.join(handoffDir, 'handoff.md'), 'utf8')
  assert.match(handoffMd, /Findings:/, 'the markdown has a Findings section')
  assert.match(handoffMd, /Port 58490 is blocked by the firewall on device B/, 'the markdown carries the observed fact')
  assert.match(handoffMd, /Decisions:/, 'the markdown has a Decisions section')
  assert.match(handoffMd, /supersedes: /, 'the markdown carries the revocable relation')

  // ---- Leg 4: Human QA restart recovery — every cli() above is already a fresh process;
  // this final full-context read asserts NOTHING was lost or re-stated across the relay.
  const ctx = jsonOut(['work', taskId])
  assert.equal(ctx.task.taskId, taskId)
  assert.equal(ctx.episodes.length, 1)
  assert.equal(ctx.episodes[0].role, 'agent', 'attribution survives the restart')
  assert.equal(ctx.sources.length, 1)
  assert.equal(ctx.findings.length, 1)
  assert.equal(ctx.findings[0].verificationLevel, 'observed', 'the fact is still an observed fact')
  assert.equal(ctx.decisions.length, 2)
  assert.deepEqual(ctx.decisions.find(d => d.decisionId === dec1.decisionId).supersededBy, [dec2.decisionId], 'the supersede chain survives the restart')
  assert.ok(ctx.handoff.findings.length === 1 && ctx.handoff.decisions.length === 2, 'the context handoff JSON still carries facts + choices')

  // A second full read (another fresh open) is identical — the reopened library is stable.
  const ctx2 = jsonOut(['work', taskId])
  assert.deepEqual(
    { f: ctx2.findings, d: ctx2.decisions, e: ctx2.episodes, s: ctx2.sources },
    { f: ctx.findings, d: ctx.decisions, e: ctx.episodes, s: ctx.sources },
    'restart read-back is byte-stable (idempotent open, no migration drift)'
  )
})
