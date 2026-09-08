import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  localDayKey, strictBase64, checkImportFileSize, pendingDeleteName, classifyBackupError, IMPORT_MAX_BYTES
} = require('../src/main/fix-util.js')

/* ---- localDayKey (float-ledger "today only" clamp, fixes #7) ---- */
test('localDayKey: local timezone YYYY-MM-DD', () => {
  // Use local-midnight components to stay timezone-independent in CI
  const d = new Date(2026, 8, 9, 23, 59, 59)
  assert.equal(localDayKey(d.getTime()), '2026-09-09')
  assert.equal(localDayKey(0), localDayKey(new Date(0).getTime()))
  assert.match(localDayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/)
})

/* ---- strictBase64 (attachment validation, fixes #6) ---- */
test('strictBase64: accepts canonical base64, tolerates whitespace', () => {
  assert.equal(strictBase64('aGVsbG8='), 'aGVsbG8=') // "hello"
  assert.equal(strictBase64('aGVs bG8=\n'), 'aGVsbG8=') // whitespace stripped
  assert.equal(strictBase64('aaaa'), 'aaaa') // length%4==0 without padding is canonical
})
test('strictBase64: rejects non-base64 garbage, bad padding, empty', () => {
  assert.equal(strictBase64('not*valid!!'), null) // charset violation
  assert.equal(strictBase64('a'), null) // length%4 != 0
  assert.equal(strictBase64('aa=a'), null) // '=' not at the tail
  assert.equal(strictBase64('a==='), null)
  assert.equal(strictBase64(''), null)
  assert.equal(strictBase64(undefined), null)
  assert.equal(strictBase64(null), null)
})

/* ---- checkImportFileSize (import:pick-preview 20MB gate, fixes #8) ---- */
test('checkImportFileSize: within cap passes, over cap returns message', () => {
  assert.equal(checkImportFileSize(1024), null)
  assert.equal(checkImportFileSize(IMPORT_MAX_BYTES), null) // exactly at cap is fine
  const err = checkImportFileSize(IMPORT_MAX_BYTES + 1)
  assert.match(err, /too large/)
  assert.match(checkImportFileSize(21 * 1024 * 1024), /20MB limit/)
})
test('checkImportFileSize: malformed stat input is an error, not a silent pass', () => {
  assert.match(checkImportFileSize(NaN), /cannot stat/)
  assert.match(checkImportFileSize(-1), /cannot stat/)
})

/* ---- pendingDeleteName (reset-data EPERM fallback, fixes #2) ---- */
test('pendingDeleteName: prefixed, timestamped, filename sanitized', () => {
  assert.equal(pendingDeleteName('todos.db', 123), 'pending-delete-123-todos.db')
  assert.equal(pendingDeleteName('todos.db-wal', 456), 'pending-delete-456-todos.db-wal')
  // path-hostile names cannot escape userData when swept back later
  assert.equal(pendingDeleteName('..\\evil.db', 1), 'pending-delete-1-.._evil.db')
  assert.equal(pendingDeleteName('a:b?.db', 1), 'pending-delete-1-a_b_.db')
  assert.match(pendingDeleteName('x', undefined), /^pending-delete-\d+-x$/)
})

/* ---- classifyBackupError (backup list error state, fixes #9) ---- */
test('classifyBackupError: missing dir is "missing", anything else is read-failed', () => {
  const e = new Error('nope'); e.code = 'ENOENT'
  assert.equal(classifyBackupError(e), 'missing')
  assert.equal(classifyBackupError({ code: 'EACCES' }), 'read-failed')
  assert.equal(classifyBackupError(new Error('EPERM-ish')), 'read-failed')
  assert.equal(classifyBackupError(null), 'read-failed')
})
