/**
 * [uiux-2026-10-01 J5 P3] Landing on the bare #/todo-list route rendered a completely blank main
 * area — no view component, no nav item highlighted — reading as a crash/dead end until a nav
 * item was clicked. The route now redirects to the concrete default view (today), mirroring the
 * index redirect.
 * Run: node --test tests/unit/renderer/uiux-1001-base-route-redirect.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('J5 P3: the bare /todo-list route redirects to a concrete view', () => {
  const src = read('renderer/js/router.js')
  const m = src.match(/path: '\/todo-list',\s*name: 'todo-list',\s*component: AppShell,[\s\S]{0,600}?children:/)
  assert.ok(m, 'route shape located')
  assert.match(m[0], /redirect: '\/todo-list\/today'/,
    'bare /todo-list must redirect to today (same target as the index redirect)')
})
