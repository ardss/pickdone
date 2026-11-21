// PickDone capture extension — pure URL normalization.
// No chrome.* dependency; loaded directly by the MV3 service worker and
// unit-tested in Node.

const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);
const TRACKING_PREFIXES = ['utm_', 'si_', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref_src'];

function isTrackingParam(key) {
  const k = key.toLowerCase();
  return TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

function parseT(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // h/m/s compound form, e.g. 1m30s / 2h5m / 45s
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

function youtubeCanonical(url) {
  let videoId = null;
  let tSeconds = null;
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (id) videoId = id;
  } else {
    videoId = url.searchParams.get('v');
  }
  if (!videoId) return null;
  const t = url.searchParams.get('t') || url.searchParams.get('start');
  tSeconds = parseT(t);
  let canonical = `https://www.youtube.com/watch?v=${videoId}`;
  if (tSeconds != null) canonical += `&t=${tSeconds}`;
  return { canonicalUri: canonical, videoId, tSeconds: tSeconds ?? null };
}

/**
 * Normalize a captured page URL.
 * @returns {{ canonicalUri: string, videoId: string|null, tSeconds: number|null }}
 */
export function normalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { canonicalUri: String(rawUrl || ''), videoId: null, tSeconds: null };
  }
  if (YT_HOSTS.has(url.hostname.toLowerCase())) {
    const yt = youtubeCanonical(url);
    if (yt) return yt;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  // Canonical param order for stable fingerprints.
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of params) url.searchParams.append(k, v);
  return { canonicalUri: url.toString(), videoId: null, tSeconds: null };
}

/**
 * SHA-256 hex fingerprint of the canonical URI (dedup key).
 * Uses the platform Web Crypto API (available in service workers and Node >= 19).
 */
export async function fingerprint(canonicalUri) {
  const data = new TextEncoder().encode(canonicalUri);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
