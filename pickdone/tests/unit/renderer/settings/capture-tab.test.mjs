/**
 * [S4 capture-endpoint RED→GREEN] SettingsCaptureTab.vue — settings-tab behaviors + the
 * SettingsModal registration anchors.
 *
 * The .vue is exercised BEHAVIORALLY: the plain-JS <script> block is extracted, the single
 * commandBus import is replaced by a recording stub, and the options object (data/mounted/
 * methods) is driven directly against a stubbed window.todoAPI — the same stub seam the
 * winbind store tests use. Template wiring is locked with source anchors (repo convention:
 * w16-deck / maint-* tests).
 *
 * Behavior under test (red-line 4):
 *   - the toggle DEFAULTS OFF (absent meta rows = off; nothing exposed until the user opts in);
 *   - enabling commits the enable meta row AND mints + persists a 48-hex access key;
 *   - an enabled endpoint without a stored key mints one on open (fail-closed);
 *   - the key text + Copy + Regenerate controls only render while enabled (v-if anchor);
 *   - Regenerate persists a NEW key (different from the old one) through the SAME bus door;
 *   - Copy writes the key text to the clipboard;
 *   - SettingsModal registers the tab (component import + registration + tab entry + panel).
 *
 * Run: node --test tests/unit/renderer/settings/capture-tab.test.mjs
 */
import '../../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const TAB_SRC = read('renderer/js/components/settings/SettingsCaptureTab.vue')
const MODAL_SRC = read('renderer/js/components/SettingsModal.vue')

/** Extract the component's options object, stubbing its single import. */
function loadComponent () {
  const m = TAB_SRC.match(/<script lang="ts">([\s\S]*?)<\/script>/)
  assert.ok(m, 'a <script lang="ts"> block exists (sfc-gate shape; plain-JS content so this loader can eval it)')
  let code = m[1]
  assert.ok(code.includes("from '../../utils/commandBus.js'"), 'the single import is the commandBus facade')
  code = code.replace(/^import [^\n]+\n/m, '')
  code = code.replace(/export default/, 'return')
  return new Function('commit', code)
}

/** Build a live instance: data + methods bound to it, against a stubbed todoAPI/clipboard. */
async function mount ({ metaRows = [], stubCommit } = {}) {
  const commits = []
  const commit = stubCommit || ((entity, verb, payload) => { commits.push([entity, verb, payload]); return Promise.resolve(true) })
  const opts = loadComponent()(commit)
  const inst = Object.assign({}, opts.data())
  for (const [name, fn] of Object.entries(opts.methods)) inst[name] = fn.bind(inst)
  globalThis.window.todoAPI = {
    getMetaMany: async () => metaRows.map(([key, value]) => ({ key, value }))
  }
  const clipWrites = []
  const clip = { writeText: async t => { clipWrites.push(t) } }
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: clip }, configurable: true })
  await opts.mounted.call(inst)
  return { inst, commits, opts, clipWrites }
}

/* ---------- 1. default OFF ---------- */

test('the toggle defaults OFF: absent meta rows leave the endpoint disabled and no writes happen', async () => {
  const { inst, commits } = await mount({})
  assert.equal(inst.loaded, true)
  assert.equal(inst.captureEnabled, false, 'default off')
  assert.equal(inst.captureKey, '')
  assert.equal(commits.length, 0, 'a closed tab writes nothing')
  // template anchor: the key/copy/regen controls are inside v-if="captureEnabled" (not exposed while off)
  assert.ok(TAB_SRC.includes('v-if="captureEnabled"'), 'key controls are gated on the enabled flag')
  assert.ok(/:model-value="captureEnabled"/.test(TAB_SRC), 'the switch binds the enabled flag')
})

/* ---------- 2. enabling persists state + mints a key ---------- */

test('enabling commits the enable row and mints + persists a 48-hex key via meta.put', async () => {
  const { inst, commits } = await mount({})
  await inst.toggleCapture(true)
  const put = commits.filter(([e, v]) => e === 'meta' && v === 'put')
  assert.equal(put.length, 2, 'enable row + secret row, both through meta.put')
  const [key0, val0] = put[0][2]
  const [key1, val1] = put[1][2]
  assert.deepEqual([key0, val0], ['_captureEndpointEnabled', '1'])
  assert.equal(key1, '_captureEndpointSecret')
  assert.match(val1, /^[0-9a-f]{48}$/)
  assert.equal(inst.captureKey, val1)
  // both meta KEYS are '_'-prefixed machine-local rows (never sync to a peer)
  assert.ok(key0.startsWith('_') && key1.startsWith('_'))
})

test('turning the toggle back OFF commits the enable row with 0', async () => {
  const { inst, commits } = await mount({})
  await inst.toggleCapture(false)
  assert.deepEqual(commits[0], ['meta', 'put', ['_captureEndpointEnabled', '0']])
  assert.equal(commits.length, 1, 'disabling writes no secret')
})

test('an enabled endpoint without a stored key mints one when the tab opens (fail-closed)', async () => {
  const { inst, commits } = await mount({ metaRows: [['_captureEndpointEnabled', '1']] })
  assert.equal(inst.captureEnabled, true)
  assert.match(inst.captureKey, /^[0-9a-f]{48}$/)
  const put = commits.filter(([e, v]) => e === 'meta' && v === 'put')
  assert.equal(put.length, 1)
  assert.equal(put[0][2][0], '_captureEndpointSecret')
})

/* ---------- 3. refresh shows the stored state ---------- */

test('refresh reflects the stored enabled state and key text', async () => {
  const storedKey = 'a'.repeat(48)
  const { inst, commits } = await mount({
    metaRows: [['_captureEndpointEnabled', '1'], ['_captureEndpointSecret', storedKey]]
  })
  assert.equal(inst.captureEnabled, true)
  assert.equal(inst.captureKey, storedKey)
  assert.equal(commits.length, 0, 'no rewrite when state is complete')
  assert.ok(TAB_SRC.includes('{{ captureKey'), 'the key text is rendered in the template')
})

/* ---------- 4. regenerate + copy ---------- */

test('regenerate persists a NEW key different from the old one, through the same bus door', async () => {
  const oldKey = 'b'.repeat(48)
  const { inst, commits } = await mount({
    metaRows: [['_captureEndpointEnabled', '1'], ['_captureEndpointSecret', oldKey]]
  })
  await inst.regenKey()
  assert.notEqual(inst.captureKey, oldKey)
  assert.match(inst.captureKey, /^[0-9a-f]{48}$/)
  const put = commits.find(([e, v]) => e === 'meta' && v === 'put')
  assert.deepEqual(put[2], ['_captureEndpointSecret', inst.captureKey])
  assert.ok(TAB_SRC.includes('capture-regen-btn'), 'the regenerate button exists in the template')
})

test('copy writes the exact key text to the clipboard', async () => {
  const storedKey = 'c'.repeat(48)
  const { inst, clipWrites } = await mount({
    metaRows: [['_captureEndpointEnabled', '1'], ['_captureEndpointSecret', storedKey]]
  })
  await inst.copyKey()
  assert.deepEqual(clipWrites, [storedKey])
  assert.ok(TAB_SRC.includes('capture-copy-btn'), 'the copy button exists in the template')
})

/* ---------- 5. SettingsModal registration anchors ---------- */

test('SettingsModal registers the capture tab (import + components + tab entry + panel)', () => {
  assert.ok(MODAL_SRC.includes("import SettingsCaptureTab from './settings/SettingsCaptureTab.vue'"), 'import line')
  assert.ok(/components: \{[^}]*SettingsCaptureTab/.test(MODAL_SRC), 'components registration')
  assert.ok(/\['capture',/.test(MODAL_SRC), "the tabs computed carries a 'capture' entry")
  assert.ok(/<settings-capture-tab[^>]*v-show="searching \|\| tab==='capture'"/.test(MODAL_SRC),
    'the panel renders on the capture tab (and in search results), same convention as the sibling tabs')
})
