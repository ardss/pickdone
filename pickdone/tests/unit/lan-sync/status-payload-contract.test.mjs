/**
 * Status-payload CONTRACT test — the systematic answer to the 2026-10-09 discovered[] loss.
 *
 * The LAN-sync status travels a 3-hop relay: node.getStatus() -> lan-sync-bootstrap
 * getStatusPayload() (field-by-field reassembly) -> renderer (SettingsSyncTab) + CLI (lib-sync).
 * Every hop used to be free to drop fields silently: the node had `discovered`, the payload
 * never carried it, and nothing failed until a USER noticed the UI had no auto-discovery.
 *
 * This test pins the hand-off in BOTH directions:
 *  1. the node really provides the fields the payload reassembles (functional, real node);
 *  2. every field the renderer/CLI actually READ is provided by the payload (source scan) —
 *     a new `status.<field>` read in the UI without a payload provider now fails here, at CI,
 *     not in front of a user.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const { createLanSyncNode } = require(path.join(ROOT, 'src/main/lan-sync/index.js'))

const PAYLOAD_SRC = readFileSync(path.join(ROOT, 'src/main/lan-sync-bootstrap.js'), 'utf8')
const TAB_SRC = readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsSyncTab.vue'), 'utf8')
const CLI_SRC = readFileSync(path.join(ROOT, 'cli/lib-sync.cjs'), 'utf8')

/** Fields the payload contract must provide at the top level (renderer + CLI consumers). */
const REQUIRED_FIELDS = [
  'enabled', 'deviceId', 'deviceName', 'hasPairingSecret', // getSettingsPayload spread (`...s`)
  'listening', 'port', 'self',
  'peers', 'discovered', 'recent', 'security', 'flushQuarantine', 'pendingPair',
  'lastRoundAt', 'lastError',
]

test('contract: the node getStatus() provides the node-side fields the payload reassembles', () => {
  const node = createLanSyncNode({
    deviceId: 'contract-node', name: 'Contract', pairingSecret: 'contract-secret',
    port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: () => {}, ingestSnapshot: () => {}, buildSegments: () => [],
  })
  const st = node.getStatus()
  for (const f of ['listening', 'port', 'self', 'peers', 'discovered', 'recent', 'security', 'lastRoundAt', 'lastError']) {
    assert.ok(f in st, `node.getStatus() must provide ${f} — the payload cannot reassemble what the node lacks`)
  }
})

test('contract: getStatusPayload provides every REQUIRED field (both node-less and node branches)', () => {
  // precise pins on the reassembly block: each payload field is EXPLICITLY carried
  for (const [field, literal] of [
    ['discovered', 'discovered: st.discovered || []'],
    ['peers', 'peers: (st.peers ||'],
    ['flushQuarantine', 'flushQuarantine,'],
    ['pendingPair', 'pendingPair,'],
    ['self', 'self: st.self'],
    ['listening', 'listening: st.listening'],
    ['lastRoundAt', 'lastRoundAt: st.lastRoundAt'],
    ['lastError', 'lastError: st.lastError'],
  ]) {
    assert.ok(PAYLOAD_SRC.includes(literal), `getStatusPayload must carry "${field}" (${literal}) — the field-by-field reassembly silently drops anything not spelled out (the 2026-10-09 discovered[] loss)`)
  }
  // node-less branch must not regress either: the empty-node return spells discovered too
  const nodeLess = PAYLOAD_SRC.slice(PAYLOAD_SRC.indexOf('if (!state.node)'), PAYLOAD_SRC.indexOf('const st = state.node.getStatus()'))
  assert.ok(nodeLess.includes('discovered: []'), 'the node-less branch must provide discovered: [] (UI opens the tab while sync is off)')
})

test('contract: every status.<field> the RENDERER reads is a provided payload field', () => {
  // collect the top-level status fields the tab actually reads
  const reads = new Set()
  for (const m of TAB_SRC.matchAll(/status && status\.(\w+)/g)) reads.add(m[1])
  for (const m of TAB_SRC.matchAll(/this\.status\.(\w+)/g)) reads.add(m[1])
  assert.ok(reads.size >= 5, 'sanity: the scan found the tab\'s real reads, got ' + [...reads].join(','))
  // computed shorthands route through `status && status.X` — anything else is a new read
  const unknown = [...reads].filter(f => !REQUIRED_FIELDS.includes(f))
  assert.deepEqual(unknown, [], `SettingsSyncTab reads status.${unknown[0]} but the payload contract does not provide it — either the payload dropped a field (fix the payload) or the read is stale (fix the tab)`)
})

test('contract: every st.<field> the CLI reads is a provided payload field', () => {
  const reads = new Set()
  for (const m of CLI_SRC.matchAll(/\bst\.(\w+)/g)) reads.add(m[1])
  // CLI also gets settings-level fields via the same payload (`...s` spread)
  const unknown = [...reads].filter(f => !REQUIRED_FIELDS.includes(f))
  assert.deepEqual(unknown, [], `cli/lib-sync.cjs reads st.${unknown[0]} but the payload contract does not provide it`)
})
