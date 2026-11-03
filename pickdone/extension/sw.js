// PickDone Capture — MV3 service worker.
// Captures the active tab URL via the context menu (activeTab), normalizes it,
// and queues it in chrome.storage.local. Delivery to the PickDone desktop app
// is retried with 1m/5m/30m backoff; entries are never dropped on failure.

import { normalizeUrl, fingerprint } from './shared/capture-url.js';
import { createQueue } from './shared/queue.js';

const DELIVER_ENDPOINT_DEFAULT = 'http://127.0.0.1:8741/api/capture';

async function getEndpoint() {
  const got = await chrome.storage.local.get('pdEndpoint');
  return got.pdEndpoint || DELIVER_ENDPOINT_DEFAULT;
}

async function deliver(payload) {
  const endpoint = await getEndpoint();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`delivery failed: HTTP ${res.status}`);
}

const queue = createQueue({
  storage: chrome.storage.local,
  alarms: chrome.alarms || null, // no "alarms" permission: retries piggyback on wake events
  deliver,
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'pd-capture-page',
    title: 'Capture page to PickDone',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'pd-capture-page') return;
  const rawUrl = info.pageUrl;
  const { canonicalUri, videoId, tSeconds } = normalizeUrl(rawUrl);
  const fp = await fingerprint(canonicalUri);
  await queue.enqueue({ payload: { canonicalUri, videoId, tSeconds, fingerprint: fp }, canonicalUri, fingerprint: fp });
  await queue.flush();
});

chrome.runtime.onStartup.addListener(() => {
  queue.flush(); // drain entries queued while PickDone was closed
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pd-queue-flush') {
    queue.flush().then(sendResponse);
    return true;
  }
  if (msg?.type === 'pd-queue-list') {
    queue.load().then((entries) => sendResponse({ entries }));
    return true;
  }
  return false;
});
