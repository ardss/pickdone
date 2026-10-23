/**
 * Pilot runner shim (D1, docs/test-runner-modernization-design.md).
 *
 * ONE export today: `test`. Files under tests/unit/utils import from here
 * instead of 'node:test' so the SAME files run under both runners:
 *   - node --test (the gate's runner): the shim resolves to node:test and is
 *     a transparent pass-through — zero gate-visible change.
 *   - vitest (tests/run-pilot.mjs): vitest sets VITEST=1 in its workers, the
 *     shim resolves to vitest's `test`. Signatures used by the pilot dir
 *     (plain `(name, fn)` cases, node:assert inside) map 1:1.
 *
 * Scope discipline: ONLY the pilot directory imports this shim during the
 * pilot wave; each later migration wave re-points one directory at a time
 * with a dual-run gate cycle (design doc, Cutover). The deep tier never
 * imports it.
 */
const isVitest = process.env.VITEST === '1' || process.env.VITEST === 'true'
const mod = isVitest ? await import('vitest') : await import('node:test')

export const test = mod.test
export const beforeEach = mod.beforeEach
export const afterEach = mod.afterEach
export const before = mod.before
export const after = mod.after
export const describe = mod.describe
export default mod.test ?? mod.default
