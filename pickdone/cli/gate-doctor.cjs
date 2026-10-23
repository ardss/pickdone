/**
 * Gate doctor (2026-10-23 architecture): declares and validates the gate's
 * environment needs BEFORE any stage runs, and auto-provisions what is
 * unambiguous. Ends the diagnose-by-archaeology class: "checkout not
 * runnable" (missing gitignored deps/baselines) and "stale port holder"
 * become a named 5-second preflight instead of a mid-gate mystery red.
 *
 * Checks are SCOPED to what the invoking gate will actually run: the fast
 * tier needs nothing beyond node_modules; the local full gate owns the
 * visual lane's machine-state needs (browser-dev deps, baselines,
 * agent-browser). CI skips the visual lane by design, so visual checks are
 * local-full-only.
 *
 * Exit codes: 0 = healthy (or auto-fixed), 2 = blocking needs unmet (named,
 * with the fix command). check-all runs this inline pre-pool unless
 * --no-doctor; standalone `node cli/gate-doctor.cjs [--fix]` for humans.
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const VDIR = path.join(ROOT, 'browser-dev')
const ART = path.join(ROOT, 'tests', '.artifacts', 'visual-web')
// The lane defines 14 scenes (× light/dark themes share the same baseline
// set name-wise — 14 current baselines after a fresh --baseline re-bless).
// A raw count >= scene count proves the re-bless completed; stale extra
// names from older scene sets are harmless (the lane reads only current).
const BASELINE_MIN = 14

function blessedCheckout () {
  // First entry of `git worktree list --porcelain` is the MAIN checkout —
  // the blessed source for gitignored machine-state (baselines).
  try {
    const out = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8' })
    const first = out.split('\n').find(l => l.startsWith('worktree '))
    return first ? first.slice('worktree '.length).trim() : null
  } catch { return null }
}

const checks = []
function check (name, { applies, test, fix, fixLabel, hint }) {
  checks.push({ name, applies, test, fix, fixLabel, hint })
}

// --- structural (every mode) ---
check('pickdone/node_modules 完整', {
  test: () => fs.existsSync(path.join(ROOT, 'node_modules', 'vitest')) || fs.existsSync(path.join(ROOT, 'node_modules', '.bin')),
  fix: null,
  hint: 'npm ci(根目录)',
})

// --- visual lane (local full gate only) ---
check('browser-dev 依赖(sirv 等,vite 配置硬依赖)', {
  applies: 'full-local',
  test: () => fs.existsSync(path.join(VDIR, 'node_modules', 'sirv')),
  fix: () => { execSync('npm i --no-audit --no-fund', { cwd: VDIR, stdio: 'ignore' }) },
  fixLabel: 'npm i(browser-dev,约 1min)',
  hint: 'cd browser-dev && npm i',
})
check('视觉基线图(gitignored 按检出机器状态)', {
  applies: 'full-local',
  test: () => fs.existsSync(ART) && fs.readdirSync(ART).filter(f => f.endsWith('.png') && !f.endsWith('.current.png')).length >= BASELINE_MIN,
  fix: () => {
    const main = blessedCheckout()
    const src = main ? path.join(main, 'pickdone', 'tests', '.artifacts', 'visual-web') : null
    if (!src || !fs.existsSync(src)) return false
    fs.mkdirSync(ART, { recursive: true })
    for (const f of fs.readdirSync(src)) {
      if (f.endsWith('.png') && !f.endsWith('.current.png')) fs.copyFileSync(path.join(src, f), path.join(ART, f))
    }
    return true
  },
  fixLabel: '从主检出拷贝基线图',
  hint: '从主检出 pickdone/tests/.artifacts/visual-web/*.png 拷入本检出',
})
check('agent-browser 可用(截图对比)', {
  applies: 'full-local',
  test: () => { try { execSync('agent-browser --version', { encoding: 'utf8', timeout: 15000, shell: true, stdio: 'ignore' }); return true } catch { return false } },
  fix: null,
  hint: '安装 agent-browser 并入 PATH',
})

async function runDoctor ({ scope, fix, silentBanner } = {}) {
  if (!silentBanner) console.log('  [gate-doctor] 环境自检...')
  const blocking = []
  for (const c of checks) {
    if (c.applies === 'full-local' && scope !== 'full-local') continue
    let ok = false
    try { ok = await c.test() } catch { ok = false }
    if (ok) continue
    let fixed = false
    if (fix && typeof c.fix === 'function') {
      try { fixed = (await c.fix()) !== false } catch { fixed = false }
      if (fixed) { try { ok = await c.test() } catch { ok = false } }
    }
    if (!ok) blocking.push({ name: c.name, hint: c.hint || c.fixLabel || '(见 docs/test-gate-map.md)', attempted: fix && typeof c.fix === 'function' })
  }
  if (blocking.length) {
    console.error(`  [gate-doctor] ✗ ${blocking.length} 项环境需求未满足:`)
    for (const b of blocking) console.error(`    ✗ ${b.name}${b.attempted ? '(自动修复后仍不满足)' : ''} — 修复: ${b.hint}`)
    return { ok: false, blocking }
  }
  if (!silentBanner) console.log('  [gate-doctor] ✓ 环境就绪')
  return { ok: true, blocking: [] }
}

module.exports = { runDoctor, checks }
if (require.main === module) {
  const scope = process.argv.includes('--full-local') ? 'full-local' : 'structural'
  runDoctor({ scope, fix: process.argv.includes('--fix') })
    .then(r => process.exit(r.ok ? 0 : 2))
} else if (!process.argv[1] || !path.basename(process.argv[1]).includes('gate-doctor')) {
  // exported for check-all inline use
}
