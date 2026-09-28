/* maint/d11-r6 renderer regressions:
 * [1] SettingsSyncTab: the last four emit-only syncEvent types (peer-online / peer-offline /
 *     flush-quarantined / sync-conflict) each have a typed consumer branch + i18n keys in BOTH
 *     locales. The r5 gate only proved consumed ⊆ doc; this round upgrades it to full
 *     emit↔consumer SET EQUIVALENCE: every emitSyncEvent('<type>') site in src/main has a
 *     renderer `evt.type ===/!== '<type>'` consumer and vice versa — no type can go dark again.
 * [2] category.js rewriteLegacyProjectIdsWithout: the cleanup promise is now returned and
 *     registered; drainLegacyRewrites() settles only after the legacy blob is scrubbed, and
 *     category/init awaits it before its union read — the cancelled project can no longer be
 *     resurrected by a racing fresh re-read (asserted here against the STORED array, i.e. the
 *     same data init()'s union would read).
 * [3] Pairing-code TTL: the renderer fallback now imports the shared 10-minute truth
 *     (shared/pairing-ttl.mjs), pinned equal to main's PAIRING_CODE_TTL_MS literal; the three
 *     remaining-seconds computations use Math.floor (repo-wide caliber), not Math.round.
 * Run: node --test tests/unit/renderer/fix-20260928-r6-renderer.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = f => readFileSync(join(ROOT, f), 'utf8')

test('r6[1a]: the four syncEvent types each have a SettingsSyncTab branch and i18n keys in both locales', () => {
  const tab = read('renderer/js/components/settings/SettingsSyncTab.vue')
  for (const t of ['peer-online', 'peer-offline', 'flush-quarantined', 'sync-conflict']) {
    assert.ok(tab.includes(`evt.type === '${t}'`), `${t} has a SettingsSyncTab branch (pre-fix: emit-only, UI never surfaced it)`)
  }
  for (const locale of ['renderer/js/i18n/en-US.js', 'renderer/js/i18n/zh-CN.js']) {
    const src = read(locale)
    for (const key of ['peerOnlineNotice', 'peerOfflineNotice', 'flushQuarantined', 'conflictFeedEntry']) {
      assert.ok(src.includes(`"${key}"`), `${key} exists in ${locale}`)
    }
  }
})

test('r6[1b]: GATE — emitSyncEvent sites in src/main and renderer evt.type consumers are SET-EQUAL', () => {
  // Emit side: every emitSyncEvent('<type>') anywhere under src/main (bootstrap + lan-sync/*).
  const emitted = new Set()
  const walkJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walkJs(join(dir, e.name)) : (e.name.endsWith('.js') ? [join(dir, e.name)] : []))
  for (const f of walkJs(join(ROOT, 'src', 'main'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/emitSyncEvent\('([a-z-]+)'/g)) emitted.add(m[1])
  }
  assert.ok(emitted.size >= 18, 'sanity: emit set collected (got ' + emitted.size + ')')
  // Consumer side: every `evt.type === '<t>'` / `evt.type !== '<t>'` guard in renderer code
  // (includes the negated early-returns in main.js and EpAttachments.vue).
  const consumed = new Set()
  for (const f of [
    'renderer/js/components/settings/SettingsSyncTab.vue',
    'renderer/js/main.js',
    'renderer/js/components/edit-panel/EpAttachments.vue',
    'renderer/js/store/tomatoAnnounce.js',
  ]) {
    for (const m of read(f).matchAll(/evt\.type [!=]== '([a-z-]+)'/g)) consumed.add(m[1])
  }
  assert.ok(consumed.size >= 18, 'sanity: consumer set collected (got ' + consumed.size + ')')
  const dark = [...emitted].filter(t => !consumed.has(t))
  assert.deepEqual(dark, [], 'every emitted syncEvent type has a renderer consumer (pre-fix: flush-quarantined/peer-online/peer-offline were black holes)')
  const ghost = [...consumed].filter(t => !emitted.has(t))
  assert.deepEqual(ghost, [], 'every renderer-consumed type is actually emitted (typo/copy-paste guard)')
})

test('r6[2]: legacy rewrite drains before a fresh read — the unmarked project cannot revive', async () => {
  let stored = JSON.stringify(['cat_keep', 'cat_r6_unmark'])
  const reads = []
  let writeGate
  const writeGatePromise = new Promise(r => { writeGate = r })
  globalThis.window.todoAPI = {
    // The first getMeta stalls until writeGate resolves: the read lands AFTER setProject's
    // fire-and-forget cleanup started but BEFORE its put committed — the pre-r6 race shape
    // (init() reading the not-yet-scrubbed blob). The rewrite itself re-reads AFTER the gate,
    // so its read-then-put still removes the id.
    dbCall: async (op, params) => {
      if (op === 'getMeta') {
        if (params[0] === 'projectCategoryIds' && reads.length === 0) {
          reads.push('raced')
          await writeGatePromise
          return JSON.stringify(['cat_keep', 'cat_r6_unmark'])
        }
        reads.push('r')
        return stored
      }
      if (op === 'setMeta' && params[0] === 'projectCategoryIds') { stored = params[1]; return { accepted: 1 } }
      return { accepted: 1 }
    },
  }
  const { rewriteLegacyProjectIdsWithout, drainLegacyRewrites } = await import('../../../renderer/js/store/category.js?r6-cat')
  const done = rewriteLegacyProjectIdsWithout('cat_r6_unmark')
  assert.ok(done && typeof done.then === 'function', 'the cleanup promise is returned (orderable), not fire-and-forget')
  // A fresh reader (init()'s union read) that races the cleanup must still wait it out:
  writeGate() // unblock the stalled read; the rewrite now completes read→filter→put
  await drainLegacyRewrites()
  const fresh = JSON.parse(stored)
  assert.ok(!fresh.includes('cat_r6_unmark'), 'fresh re-read after drain does NOT contain the unmarked id (pre-fix: racing init() union resurrected it)')
  assert.ok(fresh.includes('cat_keep'), 'unrelated ids survive the rewrite')
})

test('r6[2b]: rewrite failure stays logged, drain still resolves (no unhandled rejection)', async () => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => { warns.push(a.join(' ')) }
  try {
    globalThis.window.todoAPI = { dbCall: async () => { throw new Error('db down') } }
    const { rewriteLegacyProjectIdsWithout, drainLegacyRewrites } = await import('../../../renderer/js/store/category.js?r6-cat-fail')
    rewriteLegacyProjectIdsWithout('cat_r6_fail')
    await drainLegacyRewrites() // must resolve despite the failure
    await new Promise(r => setTimeout(r, 20))
    assert.equal(unhandled.length, 0, 'no unhandled rejection')
    assert.ok(warns.some(t => t.includes('[category] legacy project-id rewrite failed') && t.includes('cat_r6_fail')), 'failure is logged')
  } finally {
    console.warn = origWarn
    process.off('unhandledRejection', onUnhandled)
  }
})

test('r6[3]: pairing TTL is the shared 10-min truth (pinned to main literal), remaining-seconds use floor', async () => {
  const { PAIRING_CODE_TTL_MS } = await import('../../../shared/pairing-ttl.mjs')
  const tab = read('renderer/js/components/settings/SettingsSyncTab.vue')
  const main = read('src/main/lan-sync-bootstrap.js')
  // Main truth: the bootstrap's inline literal (unchanged — cross-domain) is 10 minutes.
  const m = main.match(/const PAIRING_CODE_TTL_MS = (\d+) \* (\d+) \* (\d+)/)
  assert.ok(m, 'main still declares PAIRING_CODE_TTL_MS')
  const mainTtl = Number(m[1]) * Number(m[2]) * Number(m[3])
  assert.equal(PAIRING_CODE_TTL_MS, mainTtl, 'shared constant equals the main-process literal (10 min)')
  assert.equal(PAIRING_CODE_TTL_MS, 10 * 60 * 1000, 'the renderer fallback is the 10-minute truth')
  assert.ok(tab.includes('(Date.now() + PAIRING_CODE_TTL_MS)'), 'the expiresAt fallback derives from the shared constant')
  assert.ok(!/pairingExpiresAt[^;]*5 \* 60 \* 1000/.test(tab), 'the pairing fallback no longer uses the drifted 5-min inline literal (unrelated 5-min error-window literals elsewhere are exempt)')
  // Floor caliber: no Math.round on remaining-second math anywhere in the file
  assert.ok(!tab.includes('Math.round'), 'remaining seconds use Math.floor (caliber unified repo-wide), no Math.round left')
  assert.ok((tab.match(/Math\.floor\(\(/g) || []).length >= 3, 'all three remaining-second computations use floor')
})
