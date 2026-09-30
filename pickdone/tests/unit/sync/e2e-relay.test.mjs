import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore, createRelay, startRelayServer } from '../../../server/sync-relay.mjs'
import { createRelayClient } from '../../../shared/sync-transport/https/relay-client.mjs'
import { generateAccountRootKey, deriveDataKey, seal, open, toRecoveryPhrase, fromRecoveryPhrase, wrapRootKey, unwrapRootKey } from '../../../shared/sync-crypto/e2e.mjs'

const ACCOUNT = 'e2e-acc'

async function withRelay(t) {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  return { relay, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('e2e: root key → data key derivation is deterministic and key-specific', () => {
  const a = deriveDataKey(generateAccountRootKey())
  const b = deriveDataKey(generateAccountRootKey())
  assert.notEqual(a.toString('hex'), b.toString('hex'))
  const root = generateAccountRootKey()
  assert.deepEqual(deriveDataKey(root), deriveDataKey(root))
})

test('e2e: seal/open round-trips; tampered ciphertext throws (GCM tag)', () => {
  const key = deriveDataKey(generateAccountRootKey())
  const sealed = seal(key, { title: 'secret todo' })
  assert.deepEqual(open(key, sealed), { title: 'secret todo' })
  const tampered = sealed.slice(0, -4) + 'AAAA'
  assert.throws(() => open(key, tampered))
  const wrongKey = deriveDataKey(generateAccountRootKey())
  assert.throws(() => open(wrongKey, sealed))
})

test('e2e relay loopback: two devices converge and the relay never sees plaintext', async t => {
  const { relay, baseUrl } = await withRelay(t)
  const dataKey = deriveDataKey(generateAccountRootKey())
  const a = createRelayClient({ nodeId: 'devA', account: ACCOUNT, baseUrl, dataKey })
  const b = createRelayClient({ nodeId: 'devB', account: ACCOUNT, baseUrl, dataKey })
  await a.register(); await b.register()

  await a.commit('t1', { title: 'my secret task' })
  await a.commit('t1', { title: 'my secret task v2' })
  await b.commit('t2', { title: 'other device secret' })
  await a.round(); await b.round(); await a.round()

  assert.deepEqual(a.materialized()['t2'], b.materialized()['t2'], 'cross-device title converged')
  assert.equal(a.store.revisions.get(a.store.currentByEntity.get('t1')).payload.title, 'my secret task v2')

  // relay storage: every stored envelope must be opaque — no title bytes anywhere
  const stored = relay.pull(ACCOUNT, 0, 1 << 24).items
  assert.ok(stored.length >= 3)
  for (const e of stored) {
    assert.ok(!e.envelope.includes('secret'), 'plaintext leaked into relay storage')
    assert.ok(e.envelope.startsWith('e1.'), 'envelope not AEAD-framed')
  }
})

test('e2e: snapshot upload/bootstrap works sealed; tampered snapshot aborts bootstrap', async t => {
  const { relay, baseUrl } = await withRelay(t)
  const dataKey = deriveDataKey(generateAccountRootKey())
  const a = createRelayClient({ nodeId: 'devA', account: ACCOUNT, baseUrl, dataKey })
  const b = createRelayClient({ nodeId: 'devB', account: ACCOUNT, baseUrl, dataKey })
  await a.register(); await b.register()
  await a.commit('t1', { title: 'snapshot secret' })
  await a.round()
  const up = await a.uploadSnapshot()
  assert.equal(up.entities, 1)

  // bootstrap a fresh device from snapshot + tail
  await a.commit('t1', { title: 'tail secret' })
  await a.round()
  const boot = await b.bootstrap()
  assert.equal(boot.bootstrapped, true)
  await b.round()
  assert.deepEqual(b.materialized()['t1'], a.materialized()['t1'])

  // tamper: corrupt the stored snapshot, next bootstrap must throw, not restore garbage
  const snap = relay.latestSnapshot(ACCOUNT)
  const sealedEntities = snap.entities
  const parts = sealedEntities.split('.')
  parts[3] = parts[3].slice(0, -4) + 'AAAA'
  relay.store.putSnapshot(ACCOUNT, { ...snap, entities: parts.join('.') })
  const c = createRelayClient({ nodeId: 'devC', account: ACCOUNT, baseUrl, dataKey })
  await assert.rejects(() => c.bootstrap(), /hash mismatch|e2e|authenticate/)
})

test('e2e: recovery key phrase round-trips and wraps/unwraps the root key', () => {
  const rootKey = generateAccountRootKey()
  const recoveryKey = generateAccountRootKey()
  const phrase = toRecoveryPhrase(recoveryKey)
  assert.equal(phrase.split(' ').length, 24)
  const restored = fromRecoveryPhrase(phrase)
  assert.equal(restored, recoveryKey, 'phrase round-trips to the same recovery key')
  const wrapped = wrapRootKey(rootKey, recoveryKey)
  assert.equal(unwrapRootKey(wrapped, recoveryKey), rootKey)
  assert.notEqual(wrapped, rootKey, 'root key never stored plaintext')
  assert.throws(() => unwrapRootKey(wrapped, generateAccountRootKey()), 'wrong recovery key must fail')
})
