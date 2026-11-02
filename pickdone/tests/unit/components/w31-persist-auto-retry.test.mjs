/**
 * [w31 P1] persist-confirmed upgrade: a save the probe rules UNCONFIRMED (row still in the
 * safeUpsert pending queue) now auto-retries on an exponential backoff without user action.
 *
 * w30 P0 shipped the probe (createPersistProbe, utils/editSave.js) that only LIGHTS a weak hint —
 * the user had to click Retry (or edit again) for the row to re-dispatch. This slice: when the
 * probe's verdict is stillQueued and the consumer passes a `flush`, the probe itself re-dispatches
 * after a backoff interval (2s base, x2 per consecutive unconfirmed verdict, 30s cap) and re-probes
 * after each attempt. A TERMINAL failure (classifyReplayFailure) empties the queue, so the loop
 * stops on its own — terminal never retries.
 *
 * Run: node --test tests/unit/components/w31-persist-auto-retry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// todoPendingUpserts hydrates from localStorage at load — stub the storage surface it touches.
globalThis.window = globalThis.window || { location: { hash: '' } }
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
}

const { createPersistProbe } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/editSave.js')).href)
const { classifyReplayFailure } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/store/helpers/todoPendingUpserts.js')).href)

/** Drain pending microtasks (the probe's post-flush re-probe chain) without touching mocked timers. */
const drain = () => new Promise(r => setImmediate(() => setImmediate(r)))

test('[w31] transient failure: probe verdict unconfirmed → auto flush after the backoff interval, no user action (dispatch ≥ 2)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The transient-failure shape: the row STAYS queued (safeUpsert keeps transient failures,
  // todoPendingUpserts.js safeUpsert catch), so every probe verdict is stillQueued.
  const queue = [{ op: 'upsert', params: { taskId: 'w31-retry', title: 'x' } }]
  let dispatches = 0
  const flush = async () => { dispatches++ } // transient: entry stays queued after the dispatch
  const probe = createPersistProbe(() => queue, { delayMs: 2000, backoffBaseMs: 2000, flush })
  const verdicts = []
  probe.schedule('w31-retry', (q) => { verdicts.push(q) })

  t.mock.timers.tick(2000) // settle window → probe fires, verdict unconfirmed
  await drain()
  assert.deepEqual(verdicts, [true], 'probe rules the save unconfirmed (row still queued)')
  assert.equal(dispatches, 0, 'no user action yet — nothing has re-dispatched at the probe instant')

  t.mock.timers.tick(2000) // first backoff interval elapses
  await drain()
  assert.equal(dispatches, 1, 'the flush re-dispatched on its own after the first backoff interval')

  t.mock.timers.tick(2000) // less than the doubled interval (4s)
  await drain()
  assert.equal(dispatches, 1, 'backoff is exponential: the second retry waits 2x, not 2s again')

  t.mock.timers.tick(2000) // the doubled interval elapses
  await drain()
  assert.ok(dispatches >= 2, 'without any user action the queue re-dispatched again (got ' + dispatches + ')')

  t.mock.timers.tick(8000)
  await drain()
  t.mock.timers.tick(60000)
  await drain()
  assert.ok(dispatches >= 3, 'retries keep going while the row stays unconfirmed (got ' + dispatches + ')')
  assert.equal(verdicts.every(v => v === true), true, 'every verdict stayed unconfirmed (row never persisted)')
})

test('[w31] terminal failure (classifyReplayFailure): the queue empties, the retry loop stops (no re-dispatch)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Same wiring safeUpsert's catch uses: dispatch fails, classifyReplayFailure decides.
  // A UNIQUE-violation is terminal → the entry is dropped from the queue (todoPendingUpserts.js).
  const queue = [{ op: 'upsert', params: { taskId: 'w31-terminal', title: 'y' } }]
  let dispatches = 0
  const flush = async () => {
    dispatches++
    const err = new Error('UNIQUE constraint failed: todos.index_todos_repeat_day')
    if (classifyReplayFailure(err, queue[0]) === 'terminal') queue.splice(0, queue.length)
  }
  const probe = createPersistProbe(() => queue, { delayMs: 2000, backoffBaseMs: 2000, flush })
  const verdicts = []
  probe.schedule('w31-terminal', (q) => { verdicts.push(q) })

  t.mock.timers.tick(2000) // settle window → probe fires, arms the first retry
  await drain()
  t.mock.timers.tick(2000) // first backoff interval elapses → the retry dispatches
  await drain()
  assert.equal(dispatches, 1, 'the terminal entry was attempted once')
  assert.equal(queue.length, 0, 'the terminal entry was dropped from the replay queue')
  assert.equal(verdicts.at(-1), false, 'post-flush re-probe: queue empty → confirmed, loop ends')

  t.mock.timers.tick(60000)
  await drain()
  assert.equal(dispatches, 1, 'a terminal failure never retries — no doom loop')
})
