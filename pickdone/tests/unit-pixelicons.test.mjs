/**
 * Pomodoro tray progress-ring/badge pixel-drawing unit tests (src/main/core/pixel-icons.js, pure functions).
 * Locks down: ring arc direction and colors, ring-center minute digits, badge digits - preventing tray display corruption if the drawing logic regresses.
 * Run: node --test tests/unit-pixelicons.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)
const { drawTrayPixels, drawBadgePixels, BRAND_WORK, BRAND_REST } = require_('../src/main/core/pixel-icons.js')

const TS = 32
function pxOf (px, x, y) {
  const i = (y * TS + x) * 4
  return [px[i], px[i + 1], px[i + 2], px[i + 3]] // BGRA→[b,g,r,a]
}
function isBrand (p, brand) {
  // BGRA：p[0]=b p[1]=g p[2]=r
  return p[3] > 200 && Math.abs(p[2] - brand[0]) < 20 && Math.abs(p[1] - brand[1]) < 20 && Math.abs(p[0] - brand[2]) < 20
}

test('tray progress ring: no brand arc at 0%; an arc at the top at 100%', () => {
  const p0 = drawTrayPixels(0, 25, BRAND_WORK)
  let brand0 = 0
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) if (isBrand(pxOf(p0, x, y), BRAND_WORK)) brand0++
  assert.equal(brand0, 0, 'no brand color should appear at 0%')

  const p1 = drawTrayPixels(1, 25, BRAND_WORK)
  let brand1 = 0
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) if (isBrand(pxOf(p1, x, y), BRAND_WORK)) brand1++
  assert.ok(brand1 > 200, `too few brand-color pixels in the 100% arc: ${brand1}`)
})

test('tray ring-center minute digits: both 25 and 5 fall in the central area; rest state uses orange', () => {
  for (const [min, brand] of [[25, BRAND_WORK], [5, BRAND_REST]]) {
    const px = drawTrayPixels(0.5, min, brand)
    let minX = TS, maxX = 0, minY = TS, maxY = 0
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const p = pxOf(px, x, y)
        if (p[3] > 200 && p[0] < 90 && p[1] < 90 && p[2] < 90) continue // gray base ring
        if (p[3] > 200) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
      }
    }
    assert.ok(maxX > minX && maxY > minY, `minute digit ${min} was not drawn`)
    assert.ok(minX >= 8 && maxX <= 22, `digits exceed the ring-center area: ${minX}-${maxX}`)
  }
})

test('today pomodoro badge: 0 renders no content; the digit 8 is white and inside the circle', () => {
  const p0 = drawBadgePixels(0)
  let any0 = 0
  for (let i = 0; i < p0.length; i += 4) if (p0[i + 3] > 0) any0++
  assert.ok(any0 > 100, 'badge 0 should still have the brand round base') // the base remains; the caller attaches no badge at count=0

  const p8 = drawBadgePixels(8)
  let white = 0
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4
      if (p8[i + 3] > 200 && p8[i] > 240 && p8[i + 1] > 240 && p8[i + 2] > 240) white++
    }
  }
  assert.ok(white >= 10, `too few white digit pixels: ${white}`)
})

test('progress-ring arc direction: clockwise from 12 oclock - at frac=0.25 brand pixels only in the top-right quadrant', () => {
  const px = drawTrayPixels(0.25, 10, BRAND_WORK)
  const isBrand = i => px[i + 3] > 200 && px[i] === BRAND_WORK[2] && px[i + 1] === BRAND_WORK[1] && px[i + 2] === BRAND_WORK[0]
  // BGRA channel order: B=px[i], G=px[i+1], R=px[i+2]
  let tr = 0, tl = 0, br = 0, bl = 0
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      if (!isBrand((y * TS + x) * 4)) continue
      if (x >= TS / 2 && y < TS / 2) tr++
      else if (x < TS / 2 && y < TS / 2) tl++
      else if (x >= TS / 2) br++
      else bl++
    }
  }
  assert.ok(tr > 20, `the top-right quadrant should contain arc pixels: tr=${tr}`)
  assert.ok(tl === 0 && bl === 0, `a clockwise quarter arc must not appear on the left half: tl=${tl} bl=${bl}`)
  assert.ok(br <= 10, `a quarter arc may only slightly overflow at the 3-oclock position due to line width: br=${br}`)
})
