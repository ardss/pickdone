/**
 * China cities offline coordinate table unit tests - the weather component's main city-resolution path (cnCities.js / cn-cities-data.js)
 * Background: Open-Meteo geocoding is incomplete for Chinese prefecture-level entries ("运城" not found, "北京" found),
 * so local resolution is mandatory; this pins the parsing behavior for common spellings against accidental data-file deletion/corruption.
 * Run: node --test tests/unit-cncities.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lookupCity } from '../../../renderer/js/utils/cnCities.js'
import CN_CITIES from '../../../renderer/js/utils/cn-cities-data.js'

test('data table integrity: at least 500 cities with entries as [lat, lon] in a sane range', () => {
  const keys = Object.keys(CN_CITIES)
  assert.ok(keys.length >= 500, `city count ${keys.length} < 500`)
  for (const k of keys) {
    const [lat, lon] = CN_CITIES[k]
    assert.ok(lat > 15 && lat < 55 && lon > 70 && lon < 140, `${k} coordinates out of range: ${lat},${lon}`)
  }
})

test('"运城市" must resolve locally (regression anchor for Open-Meteo geocoding lacking this Chinese entry)', () => {
  const r = lookupCity('运城市')
  assert.ok(r)
  assert.equal(r.name, '运城')
  assert.ok(Math.abs(r.lat - 35.02) < 0.5 && Math.abs(r.lon - 111) < 0.5)
})

test('all common spellings hit: municipalities/province prefixes/short names/suffix variants', () => {
  for (const q of ['北京', '北京市', '上海市', '山西省运城市', '吐鲁番', '满洲里', '台北', '香港', '呼和浩特']) {
    assert.ok(lookupCity(q), `${q} should resolve`)
  }
})

test('unlisted place names return null (left to the online fallback); garbage input does not throw', () => {
  assert.equal(lookupCity('不存在的城xyz'), null)
  assert.equal(lookupCity(''), null)
  assert.equal(lookupCity(null), null)
})
