/**
 * [w30 P1 observability] protocol.js structured 404 reason logs + renderer ep-img-broken warn.
 *
 * "第一次失败在哪一层" must be answerable from the log trail: each 404 branch in protocol.js now
 * emits one structured warn per (reason, key) with reason codes nf-missing-file /
 * nf-bad-encoding / nf-bookkeeping / nf-outside-root / nf-internal-error, and the key is logged
 * ONLY as len+fingerprint (never the raw filename — user content must not reach the log).
 * This is an anchor + semantics-preservation test: protocol.js's parsing (punycode / raw-key
 * fallback) is read-only territory and its resolution semantics must be UNCHANGED.
 *
 * Run: node --test tests/unit/main/w30-protocol-nf-reason-logs.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('[w30.3] protocol.js: every 404 branch carries its structured reason', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/protocol.js'), 'utf8')
  // local:// branches
  assert.ok(src.includes("logNf('nf-missing-file', key)"), 'realpath miss (no on-disk bytes) → nf-missing-file')
  assert.ok(src.includes("logNf('nf-bad-encoding', keyRaw)"), 'malformed percent-encoding (raw-key fallback in play) → nf-bad-encoding')
  assert.ok(src.includes("logNf('nf-bookkeeping', key)"), 'bookkeeping name never served → nf-bookkeeping')
  assert.ok(src.includes("logNf('nf-internal-error'"), 'unexpected throw → nf-internal-error')
  // app:// branch
  assert.ok(src.includes("logNf('nf-outside-root', u)"), 'allowlist rejection → nf-outside-root')
  // once-per-(reason,key) dedup + no user content in the log line
  assert.ok(src.includes('_nfReasonLogged.has(tag)'), 'one warn per (reason, key) — a LAN grid must not spam')
  assert.ok(src.includes('nfKeyTag'), 'key is reduced to len+fingerprint before logging')
  assert.ok(!/logNf\([^)]*key\+\)/.test(src), 'the raw key value is never concatenated into the log line')
})

test('[w30.3] semantics preservation: the read-only parsing branches are byte-identical contracts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/protocol.js'), 'utf8')
  // punycode/raw-key segments are read-only: the logging additions must not have touched them.
  assert.ok(src.includes("try { key = decodeURIComponent(keyRaw) } catch { logNf('nf-bad-encoding', keyRaw); /* keep raw key (attachmentPath parity) */ }"), 'raw-key fallback comment/semantics intact')
  assert.ok(src.includes("if (isLocalBookkeepingFile(path.basename(resolved))) { logNf('nf-bookkeeping', key); return new Response('nf', { status: 404 }) }"), 'bookkeeping 404 contract intact')
  assert.ok(src.includes("catch { logNf('nf-missing-file', key); return new Response('nf', { status: 404 }) }"), 'missing-file 404 contract intact')
})

test('[w30.3] renderer: ep-img-broken logs the key when the pull retry already failed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpAttachments.vue'), 'utf8')
  assert.ok(src.includes('[ep-img-broken] key='), 'second-error path warns with the key')
  assert.ok(src.includes('im.__pullTried && url'), 'warn fires only after the one-shot pull retry, not on every transient error')
})
