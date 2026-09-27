// Renderer-dist freshness check, extracted from app-dev.mjs (2026-09-28) so it is unit-testable:
// the mtime fingerprint used to miss shared/** and assets/**, so editing them left a "fresh"
// dist and npm start silently served stale build output.
// Fresh = dist index.html is strictly newer than every source that feeds the build:
//   renderer/js/**, renderer/index.html, vite.config.mjs, shared/**, assets/**
// (shared modules are bundled by vite; assets are resolved at runtime via app:// — either way a
// stale-dist skip must invalidate on any of their changes; erring toward a rebuild is safe).
import fs from 'node:fs'
import path from 'node:path'

const newestMtime = (dir, acc = 0) => {
  if (!fs.existsSync(dir)) return acc
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
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
