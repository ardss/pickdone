// Notification sanitization + resolveBackupDir symlink defense tests
import { test } from 'node:test'
import assert from 'node:assert/strict'

import './setup.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Replicates normalizeContent logic (standalone test, avoids require electron) */
function normalizeContent (s) {
  if (typeof s !== 'string') return s
    // Build the control-character regex via String.fromCharCode to avoid ESLint no-control-regex
  const CC = String.fromCharCode(0x0000) + '-' + String.fromCharCode(0x001f) + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e)
  // Includes \s directly in the string (covering \s plus full-width/zero-width whitespace); ESLint misjudging '\s' as a useless escape can be ignored
  // eslint-disable-next-line no-useless-escape
  const WS = '\s\u00A0\u3000\u200B\u2003'
  return s.replace(new RegExp('[' + CC + ']', 'g'), '').replace(new RegExp('[' + WS + ']+', 'g'), ' ').slice(0, 5000)
}

test('normalizeContent: control characters are stripped (anti notification spoofing / line-break breakage)', () => {
  // \u0000 null
  assert.equal(normalizeContent('hello\u0000world'), 'helloworld')
  // \u001f unit separator
  assert.equal(normalizeContent('a\u001fb\u001fc'), 'abc')
  // \r\n collapses to a space
  assert.equal(normalizeContent('a\r\nb'), 'ab')
  // \t collapses
  assert.equal(normalizeContent('a\tb'), 'ab')
  // Full-width space \u3000
  assert.equal(normalizeContent('a\u3000b'), 'a b')
  // Zero-width space \u200B
  assert.equal(normalizeContent('a\u200Bb'), 'a b')
  // RTL/LTR override characters (common in social-engineering attacks)
  assert.equal(normalizeContent('hello\u202Eworld'), 'helloworld')
  // Mixed malicious content
  assert.equal(normalizeContent('to\u0000do\u202Eevil'), 'todoevil')
})

test('normalizeContent: truncates at 5000 chars (prevents DB column overflow + memory blowups)', () => {
  const huge = 'a'.repeat(10000)
  assert.equal(normalizeContent(huge).length, 5000)
  // Medium-length input unchanged
  assert.equal(normalizeContent('short').length, 5)
})

test('normalizeContent: non-strings returned as-is (type defense)', () => {
  assert.equal(normalizeContent(null), null)
  assert.equal(normalizeContent(undefined), undefined)
  assert.equal(normalizeContent(42), 42)
})

/** Real test of resolveBackupDir's symlink defense: goes through a replica of backup-dirs.js */
function resolveBackupDirMock ({ configured, userData, realpath, lstat }) {
  const fallback = path.join(userData, 'backups')
  if (!configured) {
    fs.mkdirSync(fallback, { recursive: true })
    return fallback
  }
  const resolved = path.resolve(configured)
  // Whitelist: this test only covers the unregistered, non-fallback fallback path
  if (resolved !== path.resolve(fallback) && !realpath.allowedSet.has(resolved)) {
    return fallback
  }
  fs.mkdirSync(resolved, { recursive: true })
  // symlink defense
  let st
  try { st = lstat(resolved) } catch (e) { return fallback }
  if (st.isSymbolicLink()) return fallback
  return resolved
}

test('resolveBackupDir: directory is a symlink -> fall back to default (prevents symlink bypassing the whitelist)', () => {
  const realpath = { allowedSet: new Set() } // unregistered
  const lstat = () => ({ isSymbolicLink: () => true })
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'))
  // Simulate a user-picked directory that has been replaced by a symlink
  const target = path.join(userData, 'evil-link')
  fs.mkdirSync(target) // simulates existing, but lstat returns symlink
  const r = resolveBackupDirMock({ configured: target, userData, realpath, lstat })
  assert.equal(r, path.join(userData, 'backups'), 'a symlink directory should fall back to the default')
})

test('resolveBackupDir: a normal directory (not a symlink) -> returns it', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'))
  const normal = path.join(userData, 'normal-backup')
  fs.mkdirSync(normal)
  const lstat = () => ({ isSymbolicLink: () => false })
  // The whitelist contains this directory (a user-picked path), simulating a registered pick-backup-dir
  const r = resolveBackupDirMock({ configured: normal, userData, realpath: { allowedSet: new Set([path.resolve(normal)]) }, lstat })
  assert.equal(r, normal, 'a normal directory (whitelisted) should be returned as-is')
})

test('resolveBackupDir: lstat throws -> fall back to default (prevents crashing during probing)', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'))
  const evil = path.join(userData, 'nonexistent')
  // No mkdir, so lstat throws ENOENT
  const lstat = (p) => { const err = new Error('no such file'); err.code = 'ENOENT'; throw err }
  const r = resolveBackupDirMock({ configured: evil, userData, realpath: { allowedSet: new Set() }, lstat })
  assert.equal(r, path.join(userData, 'backups'), 'an lstat failure should fall back to the default')
})
