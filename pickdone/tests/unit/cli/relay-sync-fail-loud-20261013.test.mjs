import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runSync = require('../../../cli/lib-sync.cjs')

class CliError extends Error {
  constructor(message, code) { super(message); this.code = code }
}
async function invoke(ack, json = true) {
  return runSync({
    opts: { _: ['relay', 'sync'], json },
    lib: {
      CliError,
      writeSyncCmd: () => 1,
      waitForSyncAck: async () => ack,
    },
    emit: value => ({ emitted: value }),
  })
}

test('relay sync must fail loudly when command bus rejects the command', async () => {
  await assert.rejects(invoke({ ok: false, error: 'relay rejected', result: { ok: true } }), e =>
    e.code === 'SYNC_ERROR' && /relay rejected/.test(e.message))
})

test('relay sync must fail loudly when transport round failed despite successful bus ack', async () => {
  await assert.rejects(invoke({ ok: true, result: { ok: false, error: 'no-server-identity' } }), e =>
    e.code === 'SYNC_ERROR' && /no-server-identity/.test(e.message))
})

test('relay sync returns successful result through JSON mode', async () => {
  const result = { ok: true, pushed: 3, pulled: 2, businessApplied: 2, cursor: 8 }
  assert.deepEqual(await invoke({ ok: true, result }), { emitted: result })
})
