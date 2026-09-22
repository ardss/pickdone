'use strict'

/**
 * Shared future-stamp clamp window (arch review 2026-09-22, rec #3 — unify stamp clamps).
 *
 * Two choke points clamp a timestamp that lies further than one clock-skew window in the
 * future, and they MUST share one constant + one semantics, or the two doors disagree about
 * which peer stamps are legit:
 *   - src/main/command-bus.js stampPayload — the local write door (renderer IPC / main
 *     callers): an explicit stamp beyond the window is treated as forged and clamped to now.
 *   - src/main/sync-apply.js clampSkew — the remote ingress door: inbound rows beyond the
 *     window have their comparison keys (and payload fields) normalized to now.
 *
 * The value is 10 minutes (the historical sync-apply SKEW_CLAMP_MS): round4 regression pins
 * that a peer running +5min ahead keeps its stamp, and the apply-pipeline boundary test pins
 * "exactly now+10min is not clamped". Gates assert both files import THIS constant
 * (cli/check-command-bus.cjs), so the two doors can never drift apart again.
 */
const STAMP_CLAMP_MS = 10 * 60 * 1000

module.exports = { STAMP_CLAMP_MS }
