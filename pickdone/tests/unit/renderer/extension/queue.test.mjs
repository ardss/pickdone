import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, BACKOFF_MS } from '../../../../extension/shared/queue.js';

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

const ENTRY = { payload: { text: 'hello' }, canonicalUri: 'https://example.com/a' };

test('constants: backoff is 1m / 5m / 30m', () => {
  assert.deepEqual(BACKOFF_MS, [60_000, 300_000, 1_800_000]);
});

test('enqueue stores a queued entry in chrome.storage.local', async () => {
  const storage = makeStorage();
  const q = createQueue({ storage, alarms: null, deliver: async () => {} });
  const entry = await q.enqueue(ENTRY);
  assert.equal(entry.status, 'queued');
  const stored = storage.data.pdCaptureQueue;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].canonicalUri, ENTRY.canonicalUri);
});

test('failed delivery keeps the entry with status queued and never reports success', async () => {
  const storage = makeStorage();
  let calls = 0;
  const q = createQueue({
    storage,
    alarms: null,
    deliver: async () => {
      calls += 1;
      throw new Error('endpoint down');
    },
  });
  await q.enqueue(ENTRY);
  const result = await q.flush();
  assert.equal(calls, 1);
  assert.equal(result.sent.length, 0);
  const stored = storage.data.pdCaptureQueue;
  assert.equal(stored.length, 1, 'entry must be retained after failure');
  assert.equal(stored[0].status, 'queued');
  assert.equal(stored[0].attempts, 1);
});

test('successful delivery marks the entry sent and removes it from the queue', async () => {
  const storage = makeStorage();
  const delivered = [];
  const q = createQueue({
    storage,
    alarms: null,
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  await q.enqueue(ENTRY);
  const result = await q.flush();
  assert.deepEqual(delivered, [ENTRY.payload]);
  assert.equal(result.sent.length, 1);
  assert.deepEqual(storage.data.pdCaptureQueue, []);
});

test('backoff schedule: nextAttemptAt advances 1m then 5m then 30m via injected alarms', async () => {
  const storage = makeStorage();
  const created = [];
  const alarms = { create: (name, info) => created.push(info) };
  const now = 1_000_000;
  let t = now;
  const q = createQueue({
    storage,
    alarms,
    now: () => t,
    deliver: async () => {
      throw new Error('down');
    },
  });
  await q.enqueue(ENTRY);
  await q.flush();
  let stored = storage.data.pdCaptureQueue;
  assert.equal(stored[0].attempts, 1);
  assert.equal(stored[0].nextAttemptAt, now + 60_000);
  assert.deepEqual(created, [{ delayInMinutes: 1 }]);

  t = now + 60_000;
  await q.flush();
  stored = storage.data.pdCaptureQueue;
  assert.equal(stored[0].attempts, 2);
  assert.equal(stored[0].nextAttemptAt, now + 60_000 + 300_000);
  assert.deepEqual(created[1], { delayInMinutes: 5 });

  t = now + 360_000;
  await q.flush();
  stored = storage.data.pdCaptureQueue;
  assert.equal(stored[0].attempts, 3);
  assert.equal(stored[0].nextAttemptAt, now + 360_000 + 1_800_000);
  assert.deepEqual(created[2], { delayInMinutes: 30 });
});

test('entry before its nextAttemptAt is not retried on an unrelated flush', async () => {
  const storage = makeStorage();
  let t = 0;
  let calls = 0;
  const q = createQueue({
    storage,
    alarms: null,
    now: () => t,
    deliver: async () => {
      calls += 1;
      throw new Error('down');
    },
  });
  await q.enqueue(ENTRY);
  await q.flush();
  t = 30_000; // still before 1m backoff
  await q.flush();
  assert.equal(calls, 1, 'must not retry before backoff elapses');
});

test('after exhausting backoff the entry is marked failed but retained, never deleted silently', async () => {
  const storage = makeStorage();
  let t = Number.MAX_SAFE_INTEGER / 2;
  const q = createQueue({
    storage,
    alarms: null,
    now: () => t,
    deliver: async () => {
      throw new Error('down');
    },
  });
  await q.enqueue(ENTRY);
  for (let i = 0; i < 4; i++) {
    await q.flush();
    t += 3_600_000; // advance past the backoff window each round
  }
  const stored = storage.data.pdCaptureQueue;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'failed');
  assert.equal(stored[0].attempts, 4);
});

test('enqueue deduplicates by fingerprint', async () => {
  const storage = makeStorage();
  const q = createQueue({ storage, alarms: null, deliver: async () => {} });
  await q.enqueue(ENTRY);
  await q.enqueue({ ...ENTRY, payload: { text: 'same url, different text' } });
  assert.equal(storage.data.pdCaptureQueue.length, 1);
});
