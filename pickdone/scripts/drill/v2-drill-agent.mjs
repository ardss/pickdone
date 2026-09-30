#!/usr/bin/env node
/**
 * Sync v2 three-machine drill agent (dependency-free).
 *
 * Workload over the self-host relay:
 *   stage1  disjoint authoring — each device mints 10 own entities
 *   stage2  cross-device sequential edits — edit a peer's entity ONLY after a
 *           round (pull), so revisions chain causally: must yield ZERO conflicts
 *   stage3  controlled concurrency — all devices edit the SAME entity locally
 *           before any round: exactly one conflict copy per device, still convergent
 * Exits 0 only if: converged + stage2 conflicts==0 + stage3 conflicts==expected.
 *
 * Usage: node v2-drill-agent.mjs --node devA --relay 192.168.31.67:58480 [--role first|middle|last]
 */

import { createHash } from 'node:crypto'
import { createRelayClient } from '../../shared/sync-transport/https/relay-client.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const nodeId = arg('node', 'devX')
const relayHost = arg('relay', '127.0.0.1:58480')
const role = arg('role', 'last')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const client = createRelayClient({ nodeId, account: 'drill-v2', baseUrl: `http://${relayHost}` })
await client.register()

const conflicts = () => [...client.store.conflictsByEntity.values()].reduce((n, m) => n + m.size, 0)

// synchronized reporting barrier: all agents finish their workload, then hold until
// the shared deadline before final rounds + report — otherwise an early-starting
// device snapshots fleet state before later devices finish writing (race found in
// the post-fix drill rerun: A reported a stale hash)
const startedAt = Date.now()

// ---- stage 1: disjoint authoring
for (let i = 1; i <= 10; i++) await client.commit(`${nodeId}-e${i}`, { title: `${nodeId} initial ${i}` })
let r = await client.round()
console.log(JSON.stringify({ node: nodeId, stage: 1, pushed: r.pushed, conflicts: conflicts() }))

// ---- stage 2: sequential cross-device edits (pull first => causal, no conflicts)
// 'first' edits middle's entities, 'middle' edits last's, 'last' edits first's —
// staggered rounds keep the chain causal: everyone has seen stage 1 before editing.
await sleep(1500)
await client.round()
const target = { first: 'middle', middle: 'last', last: 'first' }[role]
for (let i = 1; i <= 5; i++) {
  const id = `${target}-e${i}`
  if (!client.store.currentByEntity.has(id)) continue
  await client.commit(id, { title: `${nodeId} seq-edit of ${id}` })
  await client.round()
}
console.log(JSON.stringify({ node: nodeId, stage: 2, conflicts: conflicts() }))

// ---- stage 3: controlled concurrency — ALL devices edit 'concurrent-entity'
// locally BEFORE any round (guaranteed by a staggered start gate below)
await sleep(2000)
await client.commit('concurrent-entity', { title: `concurrent claim by ${nodeId}` })
// hold until the shared barrier, then round to quiescence
const deadline = startedAt + Number(arg('deadline-ms', 25000))
while (Date.now() < deadline) await sleep(200)
for (let i = 0; i < 8; i++) { await client.round(); await sleep(200) }

const state = client.materialized()
const result = {
  node: nodeId,
  entities: Object.keys(state).length,
  conflictsTotal: conflicts(),
  conflictEntities: [...client.store.conflictsByEntity.entries()].filter(([, m]) => m.size).map(([k]) => k),
  stateHash: createHash('sha256').update(JSON.stringify(Object.keys(state).sort().map(k => k + '=' + state[k]))).digest('hex').slice(0, 16),
  concurrentWinner: client.store.revisions.get(client.store.currentByEntity.get('concurrent-entity'))?.payload?.title || null,
}
console.log('DRILL-RESULT ' + JSON.stringify(result))
