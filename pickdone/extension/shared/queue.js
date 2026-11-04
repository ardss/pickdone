// PickDone capture extension — persistent send queue backed by chrome.storage.local.
// Deps are injected so the module is testable in plain Node with mocks.

export const QUEUE_KEY = 'pdCaptureQueue';
// Retry backoff: 1 minute, 5 minutes, 30 minutes.
export const BACKOFF_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // 4 tries total, then failed

/**
 * @param {object} deps
 * @param {{get(key):Promise<object>, set(obj):Promise<void>}} deps.storage chrome.storage.local-shaped
 * @param {{create(name, info):void}|null} deps.alarms chrome.alarms or null (no alarm permission:
 *        retries then happen on the next flush trigger, e.g. SW startup / next capture)
 * @param {(payload:any)=>Promise<void>} deps.deliver
 * @param {()=>number} [deps.now]
 * @param {string} [deps.alarmName]
 */
export function createQueue({ storage, alarms, deliver, now = () => Date.now(), alarmName = 'pd-ext-queue-retry' }) {
  async function load() {
    const got = await storage.get(QUEUE_KEY);
    return Array.isArray(got[QUEUE_KEY]) ? got[QUEUE_KEY] : [];
  }
  async function save(entries) {
    await storage.set({ [QUEUE_KEY]: entries });
  }

  async function enqueueImpl(item) {
    const entries = await load();
    const key = item.fingerprint || item.canonicalUri;
    const existing = entries.find(
      (e) => (e.fingerprint && e.fingerprint === key) || e.canonicalUri === key
    );
    if (existing) return existing;
    const entry = {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      payload: item.payload,
      canonicalUri: item.canonicalUri,
      fingerprint: item.fingerprint || null,
      title: item.title || '',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now(),
    };
    entries.push(entry);
    await save(entries);
    return entry;
  }

  async function flush() {
    const entries = await load();
    const t = now();
    const sent = [];
    const failedIds = [];
    const remaining = [];
    let changed = false;
    for (const entry of entries) {
      if (entry.status !== 'queued') {
        remaining.push(entry);
        continue;
      }
      if (entry.attempts > 0 && entry.nextAttemptAt > t) {
        remaining.push(entry); // still inside backoff window
        continue;
      }
      try {
        await deliver(entry.payload);
        sent.push(entry.id);
        changed = true; // drop delivered entries
      } catch {
        changed = true;
        entry.attempts += 1;
        if (entry.attempts >= MAX_ATTEMPTS) {
          entry.status = 'failed'; // retained, never silently deleted
          failedIds.push(entry.id);
          remaining.push(entry);
        } else {
          const delay = BACKOFF_MS[entry.attempts - 1];
          entry.nextAttemptAt = t + delay;
          remaining.push(entry);
        }
      }
    }
    if (changed) await save(remaining);
    if (alarms && remaining.some((e) => e.status === 'queued' && e.nextAttemptAt > t)) {
      const next = Math.min(...remaining.filter((e) => e.status === 'queued' && e.nextAttemptAt > t).map((e) => e.nextAttemptAt));
      alarms.create(alarmName, { delayInMinutes: Math.max(1, Math.ceil((next - t) / 60_000)) });
    }
    return { sent, failedIds, pending: remaining.filter((e) => e.status === 'queued').length };
  }

  return {
    enqueue: enqueueImpl,
    flush,
    load,
  };
}
