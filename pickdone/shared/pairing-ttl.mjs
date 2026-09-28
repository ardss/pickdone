/**
 * Pairing-code TTL — the cross-runtime contract constant (r6 2026-09-28).
 *
 * The renderer's pairing dialog used a drifted 5-minute fallback while the main process
 * (src/main/lan-sync-bootstrap.js PAIRING_CODE_TTL_MS, consumed by lan-sync/pair-ops.js and
 * the CLI "valid 10 min" copy) accepts a code for 10 minutes: with expiresAt missing from the
 * status payload the UI cleared the code display at minute 5 while the main process still
 * accepted it until minute 10. Renderer consumers now derive the fallback from THIS constant;
 * tests/unit/renderer/fix-20260928-r6-renderer.test.mjs pins it against the main-process
 * literal so the two cannot drift again.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
