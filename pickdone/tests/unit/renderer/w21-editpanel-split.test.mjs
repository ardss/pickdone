/**
 * W21 (2026-10-30) EditPanel.vue structure split — registry test.
 *
 * First increment: recycle-bin banner + date chips extracted to
 * renderer/js/components/editpanel/EditPanel{BinBanner,DateChips}.vue (markup + chip-local state;
 * persistence via emits stays in the host). Later increments add ops modules.
 *
 * Constraint context (documented for the next agent): the legacy suites (w8, h7, d1, d12, dw2, w20,
 * domainA, maint waves, editpanel-behavior, d17 waves) anchor ~200+ lines of code to EditPanel.vue
 * itself by string/slice assertions — those blocks CANNOT leave the host without editing those
 * tests. This file therefore ratchets the host to the achievable bound instead of an aspirational one.
 *
 * Run: node --test tests/unit/renderer/w21-editpanel-split.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const lineCount = p => read(p).split('\n').length

const HOST = 'renderer/js/components/EditPanel.vue'
const BANNER = 'renderer/js/components/editpanel/EditPanelBinBanner.vue'
const CHIPS = 'renderer/js/components/editpanel/EditPanelDateChips.vue'

test('W21 split: host keeps the save pipeline + single-restore contract, markup children are dumb', () => {
  const host = read(HOST)
  // children communicate via props/events only — no new deps, no global state
  assert.match(host, /<ep-bin-banner v-if="inRecycle" @restore="restoreFromBin"\/>/)
  assert.match(host, /<ep-date-chips :date-ts="e&&e\.dateTs" :today0="today0" @set="setDate" @pick="onPickDate"\/>/)
  for (const f of [BANNER, CHIPS]) {
    const src = read(f)
    assert.ok(!src.includes('queueSave') && !src.includes('markDirty'), `${f} never persists directly`)
    assert.ok(!src.includes('$store'), `${f} never touches the store directly`)
  }
})

test('W21 split: EditPanelBinBanner props/events contract', () => {
  const src = read(BANNER)
  assert.match(src, /emits: \['restore'\]/)
  assert.match(src, /\$emit\('restore'\)/)
  assert.match(src, /class="ep-recycle-banner"/, 'markup moved verbatim')
  assert.match(src, /recycleBinEditTip/, 'same i18n keys')
  assert.match(src, /restoreBtn/)
})

test('W21 split: EditPanelDateChips props/events contract', () => {
  const src = read(CHIPS)
  assert.match(src, /props: \{\s*\n\s*dateTs: \{ type: Number, default: 0 \},\s*\n\s*today0: \{ type: Number, default: 0 \}\s*\n\s*\}/)
  assert.match(src, /emits: \['set', 'pick'\]/)
  assert.match(read(HOST), /@set="setDate" @pick="onPickDate"/)
  // the hidden picker is owned by the child now (its ref never crosses the boundary)
  assert.match(src, /ref="datePick"/)
  assert.ok(!read(HOST).includes('ref="datePick"'), 'datePick ref left the host with the picker')
  // chip a11y contract preserved (role=button + roleButtonActivate Space/Enter)
  assert.match(src, /roleButtonActivate/)
  assert.match(src, /class="ep-date-chip" role="button" tabindex="0"/)
  // dateChip/dayShift caliber moved verbatim (UX walk 2026-10-12 clock-time echo included)
  assert.match(src, /dayShift\(this\.today0, 1\)/)
  assert.match(src, /dateChipTime \(\)/)
})

test('W21 split: host keeps setDate (today/tomorrow/none -> applyDate) and the d23 onDateChipKey anchor', () => {
  const host = read(HOST)
  assert.match(host, /setDate \(mode\) \{\s*\n\s*if \(mode === 'today'\) this\.applyDate\(this\.today0\)/)
  assert.match(host, /onDateChipKey \(which, e\) \{\s*roleButtonActivate/)
  assert.match(host, /async restoreFromBin \(\) \{/, 'restore contract stays in the host (w20/d17-dom3)')
})

test('W21 split (B): subtask mechanics + panel setup ride vm-taking modules; anchors stay in host', () => {
  const host = read(HOST)
  assert.match(host, /initSubSortable \(\) \{ return subtaskOps\.initSubSortable\(this\) \}/)
  assert.match(host, /toggleSub \(s\) \{ return subtaskOps\.toggleSub\(this, s\) \}/)
  assert.match(read('renderer/js/components/editpanel/subtaskOps.js'), /window\.Sortable\.create\(el, \{/, 'sortable setup moved verbatim')
  assert.match(read('renderer/js/components/editpanel/subtaskOps.js'), /subsCompleteTarget\(vm\.subList, vm\.task\.complete\)/, 'parent-complete linkage moved verbatim')
  assert.match(read('renderer/js/components/editpanel/panelSetup.js'), /dynamicSpellcheckGuard/)
  assert.match(read('renderer/js/components/editpanel/panelSetup.js'), /maybeRunTour\('editpanel', 600\)/, 'spotlight tour moved verbatim')
  assert.match(host, /this\._onFocusin = panelSetup\.dynamicSpellcheckGuard\(\)/)
})

test('W21 split (C): reminder emit handlers ride editpanel/reminderOps.js (close-verify stays in host)', () => {
  const host = read(HOST)
  assert.match(host, /onRemindersCommit \(mainTs, extras\) \{ return reminderOps\.onRemindersCommit\(this, mainTs, extras\) \}/)
  assert.match(host, /onRemindersClear \(\) \{ return reminderOps\.onRemindersClear\(this\) \}/)
  assert.match(host, /onRemindersOffsets \(sorted\) \{ return reminderOps\.onRemindersOffsets\(this, sorted\) \}/)
  // store-sync-echo-round anchors the taskAbsentIn close-verify guard on the host — it stays
  assert.match(host, /taskAbsentIn\(/)
  const ops = read('renderer/js/components/editpanel/reminderOps.js')
  assert.match(ops, /reminderPastTip/, 'past-reminder toast moved verbatim')
  assert.match(ops, /offsets are anchored to the main reminder/, 'clear-offsets invariant comment moved verbatim')
})

test('W21 split: line-count ratchet (new children strict档, host at its achievable bound)', () => {
  // new files: warn 400 / error 600 per cli/check-file-size.cjs NEW_FILE_LIMITS — keep far below
  for (const f of [BANNER, CHIPS]) {
    const n = lineCount(f)
    assert.ok(n <= 400, `${f} at ${n} lines (cap 400)`)
  }
  const host = lineCount(HOST)
  // Tightened per commit: 799 pre-split → (A) 769 banner+chips → (B) 740 subtask+setup ops
  // → (C) ~722 reminder ops (close-verify had to stay: store-sync anchor). See the header for
  // why the original 560 target is unreachable (legacy anchors pin ~200+ lines in the host).
  assert.ok(host <= 725, `EditPanel.vue at ${host} lines (achievable ratchet, was 799 pre-split)`)
})
