import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../../../cli/journey-relay.cjs', import.meta.url), 'utf8')
const parseMatch = source.match(/function lastJson \(out\) \{[\s\S]*?\n\}/)
const busMatch = source.match(/const busUp = j =>[^\r\n]*/)
assert.ok(parseMatch, 'CLI output parser must exist')
assert.ok(busMatch, 'command bus readiness predicate must exist')
const parse = new Function(parseMatch[0] + ';return lastJson')()
const busUp = new Function(busMatch[0] + ';return busUp')()

test('CLI parser accepts pretty-printed JSON and preceding diagnostics', () => {
  const payload = { ok: true, command: 'sync', data: { deviceId: 'device-a' } }
  assert.deepEqual(parse(JSON.stringify(payload, null, 2)), payload)
  assert.deepEqual(parse('notice: starting\n' + JSON.stringify(payload, null, 2)), payload)
})

test('command bus readiness accepts actual CLI data.deviceId and legacy data.status.deviceId', () => {
  assert.equal(busUp({ ok: true, data: { deviceId: 'device-a' } }), true)
  assert.equal(busUp({ ok: true, data: { status: { deviceId: 'device-a' } } }), true)
  assert.equal(busUp({ ok: true, data: {} }), false)
  assert.equal(busUp({ ok: false, data: { deviceId: 'device-a' } }), false)
})
