/**
 * CI wait budget for the live-UI journeys (2026-11-21).
 *
 * Every journey below polls with a try-count that was sized on an idle developer machine
 * (10-15 × 400-500ms ≈ 4-7s). On the GitHub runner the shared interaction pool competes with
 * the unit suite and the coverage ratchet for two cores, and j-pd20-episode spawns a SECOND
 * Electron on top of the pool instance — a paint that needs 4s of quiet here needs ~10s there.
 *
 * Evidence for scaling rather than rewriting: across two consecutive runs the SAME commit red'd
 * three different pool targets (j-todo-core J2, j-habit-moment J5/J6/J7, keyboard-e2e's focus
 * check) plus — reproduceable locally with two instances live — j-pd20-episode T5; every one of
 * them passes alone, passes locally, and passes on the ubuntu leg.
 *
 * This scales the TRY COUNT, never the assertion: a genuinely broken flow still exhausts the
 * budget and fails with the same message. Nothing changes off CI (factor 1), so the local
 * signal keeps its old shape.
 */
export const waitFactor = () => (process.env.CI ? 3 : 1)

/** Scale a try-count budget for the machine we are on. */
export const waitTries = n => n * waitFactor()
