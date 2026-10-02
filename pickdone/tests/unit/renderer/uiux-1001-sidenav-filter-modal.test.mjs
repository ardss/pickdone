/**
 * [uiux-2026-10-01 J1/J5 P1] Sidebar 过滤器 "+" opened nothing: FilterModal was registered as a
 * bare arrow `() => import('./FilterModal.vue')`. Vue treats that as a functional component whose
 * render returns a Promise — Vue coerces it to the literal text '[object Promise]' injected into
 * the sidebar and the dialog never mounts. The wiring fix (defineAsyncComponent) is present on
 * this branch; this test is the regression lock so the bare-arrow registration cannot come back.
 * Run: node --test tests/unit/renderer/uiux-1001-sidenav-filter-modal.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('J1/J5 P1: FilterModal is registered through defineAsyncComponent, not a bare lazy arrow', () => {
  const src = read('renderer/js/components/SideNav.vue')
  assert.match(src, /import \{ defineAsyncComponent \} from 'vue'/)
  assert.match(
    src,
    /FilterModal:\s*defineAsyncComponent\(\(\)\s*=>\s*import\('\.\/FilterModal\.vue'\)\)/,
    'lazy chunk loading must be wrapped in defineAsyncComponent'
  )
  // The defective wiring: a bare arrow is a functional component rendering a Promise
  assert.ok(
    !/FilterModal:\s*\(\)\s*=>\s*import\(/.test(src),
    'bare () => import(...) component registration stays deleted'
  )
})
