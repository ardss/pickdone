import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQueue } from '../../../../extension/shared/queue.js'

function fixture () {
  const values = {}
  const storage = {
    get: async key => ({ [key]: values[key] }),
    set: async obj => { Object.assign(values, obj) }
  }
  let fail = true
  const delivered = []
  const queue = createQueue({
    storage,
    alarms: null,
    now: () => 2000,
    deliver: async payload => {
      if (fail) throw new Error('desktop capture port is not available')
      delivered.push(payload)
    }
  })
  return { queue, delivered, makeHealthy: () => { fail = false } }
}
test('manual Retry bypasses backoff but an automatic retry stays deferred', async () => {
  const { queue, delivered, makeHealthy } = fixture()
  await queue.enqueue({ canonicalUri: 'https://example.org/one', payload: { title: 'one' } })
  let state = await queue.flush()
  assert.equal(state.pending, 1)
  assert.equal((await queue.load())[0].attempts, 1)
  makeHealthy()
  state = await queue.flush()
  assert.equal(state.pending, 1)
  assert.equal(delivered.length, 0, 'automatic retry must not bypass backoff')
  state = await queue.flush({ force: true })
  assert.equal(state.sent.length, 1)
  assert.equal(state.pending, 0)
  assert.equal((await queue.load()).length, 0)
})
test('manual Retry can recover a permanently failed item after endpoint repair', async () => {
  const { queue, delivered, makeHealthy } = fixture()
  await queue.enqueue({ canonicalUri: 'https://example.org/two', payload: { title: 'two' } })
  for (let i = 0; i < 4; i++) await queue.flush({ force: true })
  assert.equal((await queue.load())[0].status, 'failed')
  makeHealthy()
  const result = await queue.flush({ force: true })
  assert.equal(result.sent.length, 1)
  assert.equal(result.pending, 0)
  assert.equal(delivered.length, 1)
})
