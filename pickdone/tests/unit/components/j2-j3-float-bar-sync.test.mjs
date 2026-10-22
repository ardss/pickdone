/**
 * J2 + J3 (2026-10-22 journey audit) — float close → bar toggle sync; knob glyph honesty.
 *
 * J2: closing the float via its own ✕/minimize left TomatoBar.floatOn stale for up to 15s and
 * INVERTED the next click (hideTomatoFloat on an already-hidden float = swallowed first reopen
 * click; live-verified: shown-after-click1=false). Fix: TomatoFloatPage writes a localStorage
 * ping (signal token, value never read) after its own hides; TomatoBar's storage listener
 * re-queries the AUTHORITATIVE visibility IPC. Mount-time sync stays an IPC query — a stale ping
 * across reboot can never mislead the first sync.
 *
 * J3: the knob glyph ❚❚ promised a pause that does not exist (no-pause is user-finalized); the
 * running knob's actual action is the give-up confirm → stop glyph ■; ▶ stays idle-only.
 *
 * Run: node --test tests/unit/components/j2-j3-float-bar-sync.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('J2: TomatoBar re-syncs floatOn from the authoritative IPC when the float-close ping arrives', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  assert.ok(src.includes("'tomatoFloatVisPing'"), 'TomatoBar must listen for the tomatoFloatVisPing storage key')
  // the handler must RE-QUERY the real visibility (ping value is never trusted as state)
  const handler = src.match(/_onFloatVisPing = e => \{[\s\S]*?\n\s{4}\}/)
  assert.ok(handler, 'TomatoBar: _onFloatVisPing storage handler missing')
  assert.ok(/tomatoFloatShown\(\)/.test(handler[0]), 'ping handler must re-query tomatoFloatShown (IPC), never read ping state')
  // mount-time sync stays authoritative (lead condition a): real IPC query, not the ping
  assert.ok(/tomatoFloatShown\(\)\.then\(v => \{ this\.floatOn = !!v \}\)/.test(src), 'mount-time IPC sync must remain the authoritative initial state')
  // listener must be removed on unmount (the component unmounts/remounts on view switches)
  assert.ok(/removeEventListener\('storage', this\._onFloatVisPing\)/.test(src), 'storage listener must be removed in beforeUnmount')
})

test('J2: TomatoFloatPage writes the ping after its OWN hides (✕ close and minimize), value never read back', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(/minimize \(\) \{ if \(window\.todoAPI\) window\.todoAPI\.hideTomatoFloat\(\); this\.pingVisClosed\(\) \}/.test(src), 'minimize must ping after hide')
  assert.ok(/closeFloat \(\) \{ if \(window\.todoAPI\) window\.todoAPI\.hideTomatoFloat\(\); this\.pingVisClosed\(\) \}/.test(src), 'closeFloat must ping after hide')
  assert.ok(/pingVisClosed \(\) \{\s*try \{ localStorage\.setItem\('tomatoFloatVisPing', String\(Date\.now\(\)\)\)/.test(src), 'ping must be a timestamp token written to localStorage')
  assert.ok(!/getItem\('tomatoFloatVisPing'\)/.test(src), 'nobody may READ the ping as state (signal token only)')
})

test('J3: knob glyph is phase-honest — stop ■ while running (give-up is the real action), ▶ only idle', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  const knobLine = src.split('\n').find(l => l.includes('knobIcon ()'))
  assert.ok(knobLine && !knobLine.includes('❚'), 'pause glyph ❚ must be gone from knobIcon (no pause exists)')
  assert.ok(/knobIcon\s*\(\)\s*\{\s*return\s*\(this\.working\s*\|\|\s*this\.resting\)\s*\?\s*'■'\s*:\s*'▶'\s*\}/.test(src), 'running phases must show the stop glyph ■')
})
