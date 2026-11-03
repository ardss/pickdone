/**
 * [S4 capture-endpoint RED→GREEN] handlers.js — the capture ingest logic (pure, injected bus).
 *
 * Behavior under test:
 *   - a valid payload commits the task through the REAL command bus via the 'todo.put' row
 *     (Inbox shape: no category, no scheduled day) — the bus stamps updateTime itself;
 *   - SourceRef + TaskSourceLink land through the S1 internal rows ('source.put' /
 *     'tasksource.put' → source_refs / task_source_links) via the same bus;
 *   - THIS slice's 'capture.ingest' internal manifest row (op setMetaMany) carries the dedupe
 *     index pair 'taskSourceLink:<fingerprint>' → {taskId, sourceRefId};
 *   - the same dedupeFingerprint re-sent resolves to the SAME task (duplicate, no second row);
 *   - invalid payloads (empty content, non-http sourceUrl, oversized fields) are rejected
 *     WITHOUT any bus commit;
 *   - the capture row must stay internal (never renderer-reachable, no facade row).
 *
 * Run: node --test tests/unit/main/capture-endpoint/handlers.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ingestCapture, META_TASK_LINK_PREFIX, CAPTURE_PROVIDER_ID } from '../../../../src/main/capture-endpoint/handlers.js'
import { createBus } from '../../../../src/main/command-bus.js'
import manifest from '../../../../src/main/command-manifest.js'

/* ---------- harness: a fake db layer + a REAL bus over it ---------- */

function makeHarness () {
  const ops = []
  const meta = new Map()
  let srcSeq = 0
  const dbCall = (op, params) => {
    ops.push([op, params])
    if (op === 'setMeta') { meta.set(params[0], String(params[1])); return true }
    if (op === 'setMetaMany') { for (const [k, v] of params) meta.set(String(k), String(v)); return params.length }
    if (op === 'getMeta') return meta.has(params) ? meta.get(params) : null
    if (op === 'upsert') return true
    if (op === 'sourcePut') {
      assert.equal(params.providerId, CAPTURE_PROVIDER_ID)
      return 'src_test_' + (++srcSeq) // the S1 op returns the minted sourceRef id
    }
    if (op === 'taskSourcePut') return 'tsl_test_' + srcSeq
    throw new Error('fake db: unexpected op ' + op)
  }
  const bus = createBus(dbCall)
  return { ops, meta, bus, getMeta: k => (meta.has(k) ? meta.get(k) : null) }
}

const GOOD = { content: 'Read the sync design doc', dedupeFingerprint: 'fp-abc-1', sourceUrl: 'https://example.com/doc', sourceTitle: 'Design doc' }

test('manifest: the capture internal row exists, is internal, and routes to setMetaMany', () => {
  const row = manifest.COMMANDS['capture.ingest']
  assert.ok(row, 'capture.ingest manifest row exists')
  assert.equal(row.internal, true, 'capture.ingest is internal (never renderer-reachable)')
  assert.equal(row.op, 'setMetaMany')
  assert.equal(manifest.OP_TO_COMMAND.setMetaMany, 'capture.ingest', 'op reverse-index routes setMetaMany to the capture row')
})

test('valid payload: task lands via todo.put in INBOX shape (no category, no scheduled day)', () => {
  const h = makeHarness()
  const r = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: GOOD })
  assert.equal(r.ok, true)
  assert.equal(r.status, 201)
  const todoCommits = h.ops.filter(([op]) => op === 'upsert')
  assert.equal(todoCommits.length, 1, 'exactly one todo row written')
  const t = todoCommits[0][1]
  assert.equal(t.taskContent, GOOD.content)
  assert.equal(t.categoryId, 0, 'inbox mode: no category')
  assert.equal(t.todoTime, 0, 'inbox mode: unscheduled')
  assert.equal(t.dayStart, 0, 'inbox mode: no scheduled day')
  assert.match(t.taskId, /^cap-[0-9a-f]{16}$/)
})

test('valid payload: SourceRef + TaskSourceLink land via the S1 internal rows', () => {
  const h = makeHarness()
  const r = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: GOOD })
  const src = h.ops.find(([op]) => op === 'sourcePut')
  assert.ok(src, 'source.put row was committed (source_refs)')
  assert.equal(src[1].providerId, CAPTURE_PROVIDER_ID)
  assert.equal(src[1].externalId, 'https://example.com/doc', 'the URL is the external id')
  assert.equal(src[1].title, 'Design doc')
  const link = h.ops.find(([op]) => op === 'taskSourcePut')
  assert.ok(link, 'tasksource.put row was committed (task_source_links)')
  assert.equal(link[1].taskId, r.taskId)
  assert.match(link[1].sourceRefId, /^src_test_\d+$/, 'link points at the minted source ref id')
})

test('valid payload: the capture.ingest row carries the dedupe index pair', () => {
  const h = makeHarness()
  const r = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: GOOD })
  const ingestOp = h.ops.find(([op]) => op === 'setMetaMany')
  assert.ok(ingestOp, 'dedupe pair committed through the capture.ingest row (setMetaMany)')
  const pairs = Object.fromEntries(ingestOp[1])
  const linked = JSON.parse(pairs[META_TASK_LINK_PREFIX + 'fp-abc-1'])
  assert.equal(linked.taskId, r.taskId)
  assert.ok(linked.sourceRefId, 'the pair carries the sourceRef id too')
})

test('same dedupeFingerprint re-sent: 200 duplicate, NO second task/source/link row', () => {
  const h = makeHarness()
  const first = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: GOOD })
  assert.equal(first.status, 201)
  const writesAfterFirst = h.ops.length
  const second = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: GOOD })
  assert.equal(second.status, 200)
  assert.equal(second.duplicate, true)
  assert.equal(second.taskId, first.taskId, 'the duplicate resolves to the original task')
  assert.equal(h.ops.length, writesAfterFirst, 'a duplicate capture writes NOTHING')
  assert.equal(h.ops.filter(([op]) => op === 'upsert').length, 1, 'no second row')
})

test('invalid payloads are rejected with no bus write at all', () => {
  const bad = [
    {}, // no content
    { content: '   ' }, // blank content
    { content: 'x'.repeat(5001) }, // oversized content
    { content: 'ok', dedupeFingerprint: 'bad fp with spaces and 中文' }, // fp charset
    { content: 'ok', sourceUrl: 'javascript:alert(1)' }, // non-http scheme
    { content: 'ok', sourceTitle: 't'.repeat(501) } // oversized title
  ]
  for (const payload of bad) {
    const h = makeHarness()
    const r = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload })
    assert.equal(r.ok, false, 'payload rejected: ' + JSON.stringify(payload).slice(0, 60))
    assert.equal(r.status, 400)
    assert.equal(h.ops.length, 0, 'no db write for the rejected payload')
  }
})

test('payload without a fingerprint still creates task + SourceRef + link (no dedupe pair)', () => {
  const h = makeHarness()
  const r = ingestCapture({ bus: h.bus, getMeta: h.getMeta, payload: { content: 'quick note' } })
  assert.equal(r.status, 201)
  assert.ok(h.ops.find(([op]) => op === 'sourcePut'), 'SourceRef still written')
  assert.ok(h.ops.find(([op]) => op === 'taskSourcePut'), 'TaskSourceLink still written')
  assert.equal(h.ops.some(([op]) => op === 'setMetaMany'), false, 'no dedupe pair without a fingerprint')
})

test('capture row must stay INTERNAL (never renderer-reachable, no facade row)', () => {
  const row = manifest.COMMANDS['capture.ingest']
  assert.equal(row.internal, true)
})
