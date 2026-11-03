import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, fingerprint } from '../../../../extension/shared/capture-url.js';

test('strips fragments and utm_* tracking params', () => {
  const { canonicalUri } = normalizeUrl(
    'https://example.com/page?utm_source=x&utm_medium=y&id=7#section-2'
  );
  assert.equal(canonicalUri, 'https://example.com/page?id=7');
});

test('keeps non-tracking params and ordering', () => {
  const { canonicalUri } = normalizeUrl('https://example.com/a?b=2&a=1&utm_campaign=z');
  assert.equal(canonicalUri, 'https://example.com/a?a=1&b=2');
});

test('extracts YouTube video id from watch url, drops noise, keeps t', () => {
  const r = normalizeUrl(
    'https://www.youtube.com/watch?utm_source=share&v=dQw4w9WgXcQ&t=1m30s&list=PLxyz'
  );
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
  assert.equal(r.tSeconds, 90);
  assert.equal(r.canonicalUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90');
});

test('extracts YouTube video id from youtu.be short link', () => {
  const r = normalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc&t=45');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
  assert.equal(r.tSeconds, 45);
  assert.equal(r.canonicalUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45');
});

test('parses t in seconds form and ignores empty t', () => {
  assert.equal(normalizeUrl('https://youtu.be/abc?t=200').tSeconds, 200);
  assert.equal(normalizeUrl('https://youtu.be/abc?t=').tSeconds, null);
});

test('non-youtube url passes through normalized only', () => {
  const r = normalizeUrl('https://docs.example.com/guide?utm_term=q#top');
  assert.equal(r.videoId, null);
  assert.equal(r.tSeconds, null);
  assert.equal(r.canonicalUri, 'https://docs.example.com/guide');
});

test('fingerprint is sha-256 hex of canonical uri (deterministic, differs per url)', async () => {
  const a = await fingerprint('https://example.com/page');
  const b = await fingerprint('https://example.com/page');
  const c = await fingerprint('https://example.com/other');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  // Known SHA-256 of "https://example.com/page"
  assert.equal(
    a,
    '3641c5f2274c5471278ab5bf1df6d1858d8aa392d85c51301abed2122a3c634f'
  );
});
