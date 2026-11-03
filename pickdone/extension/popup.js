// Popup: shows queue state and lets the user trigger an immediate flush.
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

refresh();
