/**
 * F4 fix (2026-10-15): verify-packaged.cjs read resources/cli/SKILL.md without an existence guard
 * (unlike the pickdone.cmd shim check) — a package that shipped resources/cli WITHOUT SKILL.md
 * crashed the gate with a raw ENOENT stack instead of a semantic FAIL + non-zero exit.
 * Asserts user-visible behavior: a fixture package missing SKILL.md gets "FAIL: SKILL.md missing"
 * and exit 1; the same fixture WITH SKILL.md passes the skill-asset stage.
 * Run: node --test tests/verify-packaged-skillmd-guard.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, 'scripts', 'verify-packaged.cjs')

// Minimal fixture: the script FAILs at the SKILL.md stage BEFORE the vendor/asar-asset scans,
// so only asar(package.json), resources/package.json and resources/cli/ are needed.
async function makeFixture (withSkillMd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-skillmd-'))
  const unpacked = path.join(tmp, 'dist', 'win-unpacked')
  const resCli = path.join(unpacked, 'resources', 'cli')
  fs.mkdirSync(resCli, { recursive: true })
  fs.writeFileSync(path.join(resCli, 'pickdone.js'), '')
  if (withSkillMd) fs.writeFileSync(path.join(resCli, 'SKILL.md'), '# skill\n')
  fs.writeFileSync(path.join(unpacked, 'resources', 'package.json'), JSON.stringify({ name: 'pickdone', version: '1.0.0' }))
  const req = createRequire(SCRIPT)
  const asar = req('@electron/asar')
  const staging = path.join(tmp, 'staging')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'pickdone', main: 'index.js', version: '1.0.0' }))
  await asar.createPackage(staging, path.join(unpacked, 'resources', 'app.asar'))
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', build: { files: [] } }))
  return tmp
}

test('F4: packaged resources/cli WITHOUT SKILL.md → semantic "FAIL: SKILL.md missing", exit 1 (no ENOENT stack)', () => {
  return (async () => {
    const dir = await makeFixture(false)
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--dir', path.join(dir, 'dist', 'win-unpacked')], { cwd: dir, encoding: 'utf8' })
      assert.equal(r.status, 1, 'gate must exit non-zero')
      assert.match(r.stderr, /FAIL: SKILL\.md missing/, 'semantic FAIL message (red before the fix: raw ENOENT stack)')
      assert.ok(!/ENOENT/.test(r.stderr), 'must not leak the raw fs error')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })()
})

test('F4: the same fixture WITH SKILL.md gets past the skill-asset stage (failure point moves on, not the new guard)', () => {
  return (async () => {
    const dir = await makeFixture(true)
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--dir', path.join(dir, 'dist', 'win-unpacked')], { cwd: dir, encoding: 'utf8' })
      // The fixture is minimal, so a LATER gate fails — but not the SKILL.md one.
      assert.equal(r.status, 1)
      assert.ok(!r.stderr.includes('SKILL.md missing'), 'with SKILL.md present the new guard must stay silent')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })()
})
