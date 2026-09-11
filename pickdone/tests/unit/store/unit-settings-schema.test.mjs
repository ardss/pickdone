/**
 * Settings enum schema pinning tests - every enum key's default in DEFAULT_SETTINGS must lie within its enum.
 * (The historical LEGACY normalization table was removed with the "no existing users" decision.) Prevents the "adding an option in only one place" drift from recurring.
 */
import '../../setup.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTING_ENUMS, DEFAULT_SETTINGS } from '../../../renderer/js/store/settings.js'

test('SETTING_ENUMS covers every enum key in DEFAULT_SETTINGS and the defaults are valid', () => {
  for (const [key, options] of Object.entries(SETTING_ENUMS)) {
    const values = options.map(o => o.v)
    assert.ok(values.length >= 2, `${key} enum needs at least 2 options`)
    if (DEFAULT_SETTINGS[key] !== undefined && DEFAULT_SETTINGS[key] !== '') {
      assert.ok(values.includes(DEFAULT_SETTINGS[key]), `${key} default ${DEFAULT_SETTINGS[key]} is not within [${values}]`)
    }
    for (const o of options) assert.ok(o.l, `${key} option ${o.v} is missing its copy key`)
  }
})

test('every enum option v is unique (dropdowns/radios must not repeat values)', () => {
  for (const [key, options] of Object.entries(SETTING_ENUMS)) {
    assert.equal(new Set(options.map(o => o.v)).size, options.length, `${key} has duplicate enum values`)
  }
})
