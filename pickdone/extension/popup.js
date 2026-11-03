// Popup: shows queue state, lets the user trigger an immediate flush, and edits the
// capture endpoint URL + access key (both persisted in chrome.storage.local and read
// by the service worker's deliver()).
const DEFAULT_ENDPOINT = 'http://127.0.0.1:7789/capture';
const endpointInput = document.getElementById('endpoint');
const apiKeyInput = document.getElementById('apiKey');

async function loadConnectionSettings() {
  const got = await chrome.storage.local.get(['pdEndpoint', 'pdCaptureKey']);
  endpointInput.value = got.pdEndpoint || DEFAULT_ENDPOINT;
  apiKeyInput.value = got.pdCaptureKey || '';
}
endpointInput.addEventListener('change', async () => {
  const url = endpointInput.value.trim();
  await chrome.storage.local.set({ pdEndpoint: url || DEFAULT_ENDPOINT });
  endpointInput.value = url || DEFAULT_ENDPOINT;
});
apiKeyInput.addEventListener('change', async () => {
  await chrome.storage.local.set({ pdCaptureKey: apiKeyInput.value.trim() });
});

function render(entries) {
  const queued = entries.filter((e) => e.status === 'queued');
  const failed = entries.filter((e) => e.status === 'failed');
  document.getElementById('summary').textContent =
    `${queued.length} queued · ${failed.length} failed`;
  const ul = document.getElementById('entries');
  ul.innerHTML = '';
  for (const e of entries.slice(-20).reverse()) {
    const li = document.createElement('li');
    li.textContent = `${e.status === 'failed' ? '✗' : '…'} ${e.title || e.canonicalUri} (${e.attempts} tries)`;
    ul.appendChild(li);
  }
}

async function refresh() {
  const { entries } = await chrome.runtime.sendMessage({ type: 'pd-queue-list' });
  render(entries || []);
}

document.getElementById('flush').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'pd-queue-flush' });
  await refresh();
  document.getElementById('summary').textContent +=
    ` — sent ${result ? result.sent.length : 0}`;
});

loadConnectionSettings();
refresh();
