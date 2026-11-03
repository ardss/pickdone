// PickDone Capture — MV3 service worker.
// Captures the active tab URL via the context menu (activeTab), normalizes it,
// and queues it in chrome.storage.local. Delivery to the PickDone desktop app
// is retried with 1m/5m/30m backoff; entries are never dropped on failure.

import { normalizeUrl, fingerprint } from './shared/capture-url.js';
import { createQueue } from './shared/queue.js';
import { DEFAULT_CAPTURE_ENDPOINT } from './shared/endpoint-contract.js';
import { createDeliver } from './shared/deliver.js';

const deliver = createDeliver({
  getEndpoint: async () => {
    const got = await chrome.storage.local.get('pdEndpoint');
    return got.pdEndpoint || DEFAULT_CAPTURE_ENDPOINT;
  },
  // the access key the user pasted in the popup — sent as the X-PickDone-Key handshake
  getKey: async () => {
    const got = await chrome.storage.local.get('pdCaptureKey');
    return got.pdCaptureKey || '';
  },
});

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

// The ONE capture body: normalize → fingerprint → enqueue → flush. The context menu and the
// 'pd-capture-page' message (the headless/testable seam — a page can't drive native menus)
// both land here, so the journey exercises the exact shipped capture path.
async function capturePageUrl (rawUrl) {
  const { canonicalUri } = normalizeUrl(rawUrl);
  const fp = await fingerprint(canonicalUri);
  // Server contract (capture-endpoint/server): {content, dedupeFingerprint?, sourceUrl?,
  // sourceTitle?}. The queued page URL is both the task text and the source link; the
  // sha-256 hex fingerprint is the server-side dedupe key. (The old shape — raw
  // {canonicalUri, fingerprint} — was rejected 400 by the desktop door: contract break
  // caught by the live Chrome journey j-pd20-extension.)
  await queue.enqueue({
    payload: { content: canonicalUri, dedupeFingerprint: fp, sourceUrl: canonicalUri },
    canonicalUri,
    fingerprint: fp,
  });
  await queue.flush();
  return { canonicalUri, fp };
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'pd-capture-page') return;
  await capturePageUrl(info.pageUrl);
});

chrome.runtime.onStartup.addListener(() => {
  queue.flush(); // drain entries queued while PickDone was closed
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pd-capture-page') {
    capturePageUrl(msg.url).then(sendResponse);
    return true;
  }
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
