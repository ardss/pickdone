'use strict'
// Static shape regression for sec-quickadd-scheme-guard-case-drift (P3 hardening):
// the will-navigate same-origin guards in quick-add.js and tomato-float.js must use the
// case-insensitive /^app:\/\/app\//i prefix, matching windows.js, so the security property
// does not depend on Chromium canonicalization if a future deep-link/loadURL path ever
// passes a non-canonicalized (mixed-case) URL string. No behavioral repro path exists
// today — all three windows receive canonical URLs — so this is a source-shape test.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
// Exact case-insensitive guard literal: /^app:\/\/app\//i
const LITERAL_CI = '/^app:\\/\\/app\\//i'
// The flagless variant must no longer appear anywhere.
const LITERAL_CS = '/^app:\\/\\/app\\//'

for (const rel of ['src/main/quick-add.js', 'src/main/tomato-float.js', 'src/main/windows.js']) {
  test(`will-navigate guard in ${rel} uses case-insensitive app://app/ prefix`, () => {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    const guardLines = src.split('\n').filter((l) => l.includes(LITERAL_CI) || l.includes(LITERAL_CS))
    assert.ok(guardLines.length > 0, `${rel} should contain a will-navigate guard`)
    for (const line of guardLines) {
      assert.ok(
        line.includes(LITERAL_CI),
        `${rel} guard regex lacks the i flag: ${line.trim()}`
      )
    }
  })
}
