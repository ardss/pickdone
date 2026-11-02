/* Shared git-subprocess env for the CLI gates (W28 2026-11-01).
 *
 * Git runs hooks with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE injected; if a gate spawns `git`
 * with those still in the environment, git resolves the repo from GIT_DIR (e.g. ".git") relative
 * to the gate's cwd instead of the tree the hook belongs to — inside GATE_ROOT fixture trees the
 * gate silently reads the REAL repo's HEAD instead of the fixture's (the exact false-green shape
 * fixed per-gate in check-file-size.cjs / check-boot-order.cjs, W18). One helper, all gates.
 * Only Node built-ins. */
function gitEnv () {
  const e = { ...process.env }
  delete e.GIT_DIR
  delete e.GIT_WORK_TREE
  delete e.GIT_INDEX_FILE
  return e
}

module.exports = { gitEnv }
