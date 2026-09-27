/* Shared recursive source-file walker for the CLI gate scripts (2026-09-28).
 * Five gates used to carry five hand-copied traversers whose skip-lists and extension sets had
 * drifted (check-boot-order missing renderer-dist, check-dualwrite skipping nothing,
 * check-esm-graph skipping nothing and missing .cjs/.mjs, check-command-bus skipping nothing) —
 * every scan-surface tightening then had to be repeated in five places and one was always missed.
 * One listFiles with options is now the single source.
 * Only Node built-ins. */
const fs = require('fs')
const path = require('path')

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'renderer-dist'])
const DEFAULT_EXTS = ['.js', '.vue', '.cjs', '.mjs']

/** Recursively list source files under dir (absolute paths).
 *  opts.skipDirs: directory basenames to prune (dot-directories are always pruned).
 *  opts.exts: extensions to include; `.d.ts` is always excluded.
 *  Vanished/unreadable entries are skipped rather than thrown (a file deleted between readdir and
 *  stat used to crash the old hand-rolled statSync walkers, e.g. check-esm-graph). */
function listFiles (dir, { skipDirs = DEFAULT_SKIP_DIRS, exts = DEFAULT_EXTS, out = [] } = {}) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (skipDirs.has(e.name) || e.name.startsWith('.')) continue
      listFiles(full, { skipDirs, exts, out })
    } else if (e.isFile() && exts.includes(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

module.exports = { listFiles, DEFAULT_SKIP_DIRS, DEFAULT_EXTS }
