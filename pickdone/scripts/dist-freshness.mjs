// Renderer-dist freshness check, extracted from app-dev.mjs (2026-09-28) so it is unit-testable:
// the mtime fingerprint used to miss shared/** and assets/**, so editing them left a "fresh"
// dist and npm start silently served stale build output.
// Fresh = dist index.html is strictly newer than every source that feeds the build:
//   renderer/js/**, renderer/index.html, vite.config.mjs, shared/**, assets/**
// (shared modules are bundled by vite; assets are resolved at runtime via app:// — either way a
// stale-dist skip must invalidate on any of their changes; erring toward a rebuild is safe).
import fs from 'node:fs'
import path from 'node:path'

// Freshness must fail toward a REBUILD, never crash: statSync inside the walk can lose a
// TOCTOU race (file deleted between readdir and stat) or hit EPERM. Any unreadable entry
// makes the whole subtree's mtime unknown → Infinity → `distM > srcMtime` is false → rebuild.
// (The per-file stats in isDistFresh already catch to 0/false; the walk was the裸 throw.)
const newestMtime = (dir, acc = 0) => {
  let entries
  try {
    if (!fs.existsSync(dir)) return acc
    entries = fs.readdirSync(dir)
  } catch { return Infinity }
  for (const f of entries) {
    const p = path.join(dir, f)
    let st
    try { st = fs.statSync(p) } catch { return Infinity }
    if (st.isDirectory()) acc = newestMtime(p, acc)
    else acc = Math.max(acc, st.mtimeMs)
  }
  return acc
}

export function isDistFresh (appRoot) {
  const distIndex = path.join(appRoot, 'renderer-dist', 'index.html')
  let distM = 0
  try { distM = fs.statSync(distIndex).mtimeMs } catch { return false }
  const j = (...segs) => path.join(appRoot, ...segs)
  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
  const srcMtime = Math.max(
    newestMtime(j('renderer', 'js')),
    mtimeOf(j('renderer', 'index.html')),
    mtimeOf(j('vite.config.mjs')),
    newestMtime(j('shared')),
    newestMtime(j('assets')),
  )
  return distM > srcMtime
}
