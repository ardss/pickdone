/**
 * Load-flake guard for relay HTTP tests (2026-10-11).
 *
 * The full unit suite runs ~11 test-file processes in parallel (node --test
 * default concurrency on a 12-core box). Under that load, a freshly started
 * relay's first HTTP exchanges occasionally die as `fetch failed`
 * (ECONNRESET / connect timeout) BEFORE the server ever sees the request —
 * three different relay tests flaked red across three full-suite runs while
 * passing green standalone every single time.
 *
 * Transport-level retries ONLY: an HTTP STATUS is a real answer and is never
 * retried. `registerT` additionally handles the one unsafe retry case — a
 * register whose response was lost AFTER the server minted the secret — by
 * falling back to a fresh device id (a blind re-register without proof would
 * 409 against the rotation guard and the minted secret is unrecoverable).
 */

/** POST JSON with connection:close (win32 keep-alive teardown) + bounded
 *  transport retries. Returns the raw fetch Response. tries/backoff tuned to
 *  outlast the multi-second CPU-saturation windows observed under the full
 *  suite (concurrency 4 still spikes loopback connects into ECONNRESET). */
export async function postT (url, body, { secret = null, tries = 5, backoffMs = 150 } = {}) {
  let last = null
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close', // pooled keep-alive teardown crashes on win32 (see relay-registration-guard.test.mjs)
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      last = e
      if (i < tries) await new Promise(r => setTimeout(r, backoffMs * i))
    }
  }
  throw last
}

/** Resilient register: retry transport failures; on 409 (secret minted
 *  server-side, response lost) fall back to a fresh device id UNLESS
 *  `fallback409: false` — rotation-guard tests that ASSERT the 409 must pass
 *  that flag so the fallback cannot swallow the assertion. Returns
 *  { status, secret, out, device } — callers must use the RETURNED device
 *  name in subsequent requests for this account. */
export async function registerT (post, base, account, device, extra = {}) {
  const { fallback409 = true, ...bodyExtra } = extra
  let res = await post(base, '/v1/device/register', { account, device, ...bodyExtra })
  let out = await res.json().catch(() => ({}))
  if (res.status === 409 && fallback409) {
    device = device + '-r' + Date.now().toString(36)
    res = await post(base, '/v1/device/register', { account, device })
    out = await res.json()
  }
  return { status: res.status, secret: out.device && out.device.deviceSecret, out, device }
}
